import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ReadFileTool } from '../../../src/tools/fs/ReadFileTool.js';
import type { Tool } from '../../../src/tools/Tool.js';
import { ToolExecutor, truncate } from '../../../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { Workspace } from '../../../src/workspace/Workspace.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

const crashingTool: Tool<{ x?: number | undefined }> = {
  name: 'crash',
  description: 'always throws',
  schema: z.object({ x: z.number().optional() }),
  risk: 'read',
  describe: () => 'boom',
  execute: async () => {
    throw new Error('kaboom');
  },
};

const chattyTool: Tool<Record<string, never>> = {
  name: 'chatty',
  description: 'returns a lot of output',
  schema: z.object({}),
  risk: 'read',
  describe: () => '',
  execute: async () => ({ output: 'x'.repeat(5000) }),
};

let root: string;
let executor: ToolExecutor;
const signal = new AbortController().signal;
const call = (name: string, args: string) => ({ id: '1', name, arguments: args });

beforeAll(() => {
  root = createTempDir({ 'a.txt': 'hello' });
  const registry = new ToolRegistry()
    .register(new ReadFileTool())
    .register(crashingTool)
    .register(chattyTool);
  executor = new ToolExecutor(registry, Workspace.open(root), { outputLimit: 1000, now: () => 0 });
});
afterAll(() => removeTempDir(root));

describe('ToolExecutor: never throws, always explains', () => {
  it('runs a valid call', async () => {
    const out = await executor.run(call('read_file', '{"path":"a.txt"}'), signal);
    expect(out).toEqual({ ok: true, output: '1\thello', summary: '1 lines', durationMs: 0 });
  });

  it('unknown tool → lists the available ones', async () => {
    const out = await executor.run(call('delete_everything', '{}'), signal);
    expect(out.ok).toBe(false);
    expect(out.output).toContain('Unknown tool "delete_everything"');
    expect(out.output).toContain('read_file, crash, chatty');
  });

  it('invalid JSON → says so', async () => {
    const out = await executor.run(call('read_file', '{path: a.txt'), signal);
    expect(out).toMatchObject({ ok: false, summary: 'bad JSON' });
  });

  it('schema violation → returns the exact validation problem', async () => {
    const out = await executor.run(call('read_file', '{"path": 42}'), signal);
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/Invalid arguments for read_file/);
    expect(out.output).toMatch(/path/);
  });

  it('empty arguments are treated as {}', async () => {
    expect((await executor.run(call('chatty', ''), signal)).ok).toBe(true);
  });

  it('a throwing tool becomes an error result, not a crash', async () => {
    const out = await executor.run(call('crash', '{}'), signal);
    expect(out).toMatchObject({ ok: false, output: 'Error: kaboom', summary: 'kaboom' });
  });

  it('huge output is truncated to protect the context window', async () => {
    const out = await executor.run(call('chatty', '{}'), signal);
    expect(out.output.length).toBeLessThan(1100);
    expect(out.output).toContain('characters omitted');
  });

  it('describe() gives the UI label, or "" for bad arguments', () => {
    expect(executor.describe(call('read_file', '{"path":"a.txt"}'))).toBe('a.txt');
    expect(executor.describe(call('read_file', 'not json'))).toBe('');
  });
});

describe('ToolRegistry', () => {
  it('produces OpenAI-style JSON Schema definitions; defaulted fields are optional', () => {
    const defs = new ToolRegistry().register(new ReadFileTool()).definitions();
    expect(defs[0]?.name).toBe('read_file');
    expect(defs[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(defs[0]?.parameters).not.toHaveProperty('$schema');
  });

  it('rejects duplicate names', () => {
    expect(() =>
      new ToolRegistry().register(new ReadFileTool()).register(new ReadFileTool()),
    ).toThrow();
  });
});

describe('truncate', () => {
  it('keeps head and tail', () => {
    const out = truncate(`${'a'.repeat(100)}${'z'.repeat(100)}`, 50);
    expect(out.startsWith('aaa')).toBe(true);
    expect(out.endsWith('zzz')).toBe(true);
  });
});
