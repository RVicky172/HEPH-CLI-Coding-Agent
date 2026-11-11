import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LLMError } from '../../../src/core/errors/LLMError.js';
import type { ChatChunk } from '../../../src/llm/LLMProvider.js';
import { OpenAICompatibleProvider } from '../../../src/llm/openai-compatible/OpenAICompatibleProvider.js';

/**
 * A tiny fake OpenAI-compatible server. Using a real HTTP server (instead of
 * mocking the SDK) tests our code exactly the way LM Studio will exercise it.
 */
type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let server: http.Server | undefined;

async function startServer(handler: Handler): Promise<string> {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

function sse(res: http.ServerResponse, events: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason }],
});

const provider = (baseURL: string) =>
  new OpenAICompatibleProvider({ name: 'test', baseURL, apiKey: 'k', maxRetries: 0 });

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe('OpenAICompatibleProvider', () => {
  it('streams text, reasoning and usage, and sends a correct request', async () => {
    let request: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const baseURL = await startServer((req, body, res) => {
      request = { url: req.url!, auth: req.headers.authorization!, body: JSON.parse(body) };
      sse(res, [
        chunk({ role: 'assistant', reasoning_content: 'thinking' }),
        chunk({ content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({}, 'stop'),
        {
          ...chunk({}),
          choices: [],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        },
      ]);
    });

    const chunks = await collect(
      provider(baseURL).chat({
        model: 'qwen',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.3,
      }),
    );

    expect(chunks).toEqual([
      { type: 'reasoning', delta: 'thinking' },
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'done', usage: { inputTokens: 7, outputTokens: 2 }, finishReason: 'stop' },
    ]);
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.auth).toBe('Bearer k');
    expect(request.body).toMatchObject({
      model: 'qwen',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('reads the loaded context length from LM Studio /api/v0/models', async () => {
    const baseURL = await startServer((req, _body, res) => {
      res.writeHead(req.url === '/api/v0/models' ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(
        JSON.stringify({
          data: [{ id: 'qwen', loaded_context_length: 18688, max_context_length: 262144 }],
        }),
      );
    });
    expect(await provider(baseURL).contextWindow('qwen')).toBe(18688);
    expect(await provider(baseURL).contextWindow('unknown')).toBeUndefined();
  });

  it('lists models', async () => {
    const baseURL = await startServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'a', object: 'model' },
            { id: 'b', object: 'model' },
          ],
        }),
      );
    });
    expect(await provider(baseURL).listModels()).toEqual(['a', 'b']);
  });

  it('maps "server not running" to a connection LLMError with an LM Studio hint', async () => {
    const baseURL = await startServer(() => {});
    const port = (server!.address() as AddressInfo).port;
    await new Promise((r) => server!.close(r));
    server = undefined;

    const error = await provider(baseURL)
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ kind: 'connection' });
    expect((error as LLMError).hint).toContain('LM Studio');
    expect((error as LLMError).message).toContain(String(port));
  });

  it('maps 401 to an auth error and 404 to not_found (with the model name)', async () => {
    let status = 401;
    const baseURL = await startServer((_req, _body, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'nope' } }));
    });

    const auth = await collect(provider(baseURL).chat({ model: 'm', messages: [] })).catch(
      (e) => e,
    );
    expect(auth).toMatchObject({ kind: 'auth' });

    status = 404;
    const notFound = await collect(provider(baseURL).chat({ model: 'ghost', messages: [] })).catch(
      (e) => e,
    );
    expect(notFound).toMatchObject({ kind: 'not_found' });
    expect((notFound as LLMError).message).toContain('ghost');
  });
});
