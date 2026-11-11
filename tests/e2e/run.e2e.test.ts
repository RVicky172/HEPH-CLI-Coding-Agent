/**
 * END-TO-END: start the real CLI as a child process (via tsx, no build needed)
 * against a tiny fake OpenAI-compatible server. Tests what a user or a CI
 * script would experience: arguments, stdin, stdout, exit codes, files on disk.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../helpers/tempWorkspace.js';

type Reply = { toolCall?: { name: string; args: object }; text?: string };
let replies: Reply[] = [];
const requests: { messages: { role: string; content: string | null }[] }[] = [];
let server: http.Server;
let baseURL: string;

function sse(res: http.ServerResponse, reply: Reply) {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (reply.toolCall) {
    res.write(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: {
                name: reply.toolCall.name,
                arguments: JSON.stringify(reply.toolCall.args),
              },
            },
          ],
        },
        'tool_calls',
      ),
    );
  } else {
    res.write(chunk({ content: reply.text ?? 'ok' }, 'stop'));
  }
  res.end('data: [DONE]\n\n');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake', object: 'model' }] }));
        return;
      }
      requests.push(JSON.parse(body));
      sse(res, replies.shift() ?? { text: 'done' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise((r) => server.close(r)));

let root: string;
beforeEach(() => {
  replies = [];
  requests.length = 0;
  root = createTempDir({ 'notes.txt': 'The answer is 42.\n' });
  return () => removeTempDir(root);
});

const CLI = path.resolve('src/cli/index.ts');
const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');

function heph(
  args: string[],
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX, CLI, ...args, '--base-url', baseURL, '-m', 'fake', '-C', root],
      {
        env: {
          ...process.env,
          NO_COLOR: '1',
          HEPH_SPINNER: 'simple',
          HOME: root,
          USERPROFILE: root,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

const jsonLines = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('heph run (end to end)', { timeout: 60_000 }, () => {
  it('--json: reads a file with a tool, answers, exits 0, and writes the audit log', async () => {
    replies = [
      { toolCall: { name: 'read_file', args: { path: 'notes.txt' } } },
      { text: 'It says 42.' },
    ];
    const { code, stdout } = await heph([
      'run',
      'what does notes.txt say?',
      '--json',
      '--reads',
      'auto',
    ]);

    const events = jsonLines(stdout);
    expect(code).toBe(0);
    expect(events[0]).toMatchObject({ type: 'start', model: 'fake' });
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
      name: 'read_file',
      ok: true,
    });
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 0, answer: 'It says 42.' });
    // the model really received the file content as a tool result
    expect(JSON.stringify(requests[1]?.messages)).toContain('The answer is 42.');

    const logs = fs.readdirSync(path.join(root, '.heph', 'logs'));
    const entries = fs
      .readFileSync(path.join(root, '.heph', 'logs', logs[0]!), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(entries[0]!)).toMatchObject({
      tool: 'read_file',
      label: 'notes.txt',
      outcome: 'ok',
    });
  });

  it('piped stdin becomes context for the task', async () => {
    replies = [{ text: 'That is a null pointer error.' }];
    const { code, stdout } = await heph(
      ['run', 'explain this error', '--json'],
      'TypeError: x is null\n  at main.js:3',
    );
    expect(code).toBe(0);
    const userMessage = requests[0]?.messages.at(-1)?.content ?? '';
    expect(userMessage).toContain('explain this error');
    expect(userMessage).toContain('<stdin>\nTypeError: x is null');
    expect(jsonLines(stdout).at(-1)).toMatchObject({ answer: 'That is a null pointer error.' });
  });

  it('SAFETY: without a terminal, changes are NOT applied in ask mode (and the model is told)', async () => {
    replies = [
      { toolCall: { name: 'write_file', args: { path: 'new.txt', content: 'x' } } },
      { text: 'Could not write.' },
    ];
    const { code, stdout } = await heph(['run', 'create new.txt', '--json']);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false);
    expect(jsonLines(stdout).some((e) => e.type === 'approval_denied')).toBe(true);
    expect(JSON.stringify(requests[1]?.messages)).toContain('NOT APPLIED');
  });

  it('--mode auto-edit lets a script apply changes', async () => {
    replies = [
      { toolCall: { name: 'write_file', args: { path: 'new.txt', content: 'hi\n' } } },
      { text: 'Created.' },
    ];
    const { code } = await heph(['run', 'create new.txt', '--json', '--mode', 'auto-edit']);
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('hi\n');
  });

  it('formatted (non-JSON) output shows the task and the answer', async () => {
    replies = [{ text: 'Hello from the fake model.' }];
    const { code, stdout } = await heph(['run', 'say hello']);
    expect(code).toBe(0);
    expect(stdout).toContain('say hello');
    expect(stdout).toContain('Hello from the fake model.');
  });

  it('a server that is down → exit code 1 with a helpful message', async () => {
    const child = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const p = spawn(
        process.execPath,
        [TSX, CLI, 'run', 'hi', '--base-url', 'http://127.0.0.1:1/v1', '-m', 'x', '-C', root],
        {
          env: { ...process.env, NO_COLOR: '1', HOME: root, USERPROFILE: root },
        },
      );
      let stderr = '';
      p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      p.stdout.on('data', (c: Buffer) => (stderr += c.toString())); // the transcript shows the error
      p.stdin.end();
      p.on('close', (code) => resolve({ code, stderr }));
    });
    expect(child.code).toBe(1);
    expect(child.stderr).toMatch(/Could not connect/); // stdout + stderr combined
  });
});

describe('sessions (end to end)', { timeout: 60_000 }, () => {
  it('chat is saved automatically, and `heph -c` continues it in a new process', async () => {
    replies = [{ text: 'Noted, your codename is TEAL.' }];
    const first = await heph([], 'Remember: my codename is TEAL.\n');
    expect(first.code).toBe(0);

    const list = await heph(['sessions']);
    expect(list.stdout).toContain('Remember: my codename is TEAL.');

    requests.length = 0;
    replies = [{ text: 'Your codename is TEAL.' }];
    const second = await heph(['-c'], 'What is my codename?\n');
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/resumed "Remember: my codename is TEAL\."/);
    // the new process sent the OLD conversation to the model
    const sent = JSON.stringify(requests[0]?.messages);
    expect(sent).toContain('my codename is TEAL');
    expect(sent).toContain('Noted, your codename is TEAL.');
  });
});

describe('heph init (end to end)', { timeout: 30_000 }, () => {
  it('creates the project files', async () => {
    const { code, stdout } = await heph(['init']);
    expect(code).toBe(0);
    expect(stdout).toContain('created');
    expect(fs.existsSync(path.join(root, 'HEPH.md'))).toBe(true);
  });
});
