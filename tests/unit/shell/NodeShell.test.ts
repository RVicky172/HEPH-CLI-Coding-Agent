import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeShell } from '../../../src/shell/NodeShell.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

/** Real processes: slower (~0.5 s each on Windows because PowerShell starts), but tests what users get. */
const isWindows = process.platform === 'win32';
const shell = new NodeShell();
let root: string;

beforeAll(() => {
  root = createTempDir({ 'sub/marker.txt': 'here' });
});
afterAll(() => removeTempDir(root));

const run = (
  command: string,
  extra: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
) => {
  const chunks: string[] = [];
  const promise = shell.run(command, {
    cwd: extra.cwd ?? root,
    timeoutMs: extra.timeoutMs ?? 30_000,
    signal: extra.signal ?? new AbortController().signal,
    onOutput: (c) => chunks.push(c),
  });
  return { promise, chunks };
};

describe('NodeShell', { timeout: 30_000 }, () => {
  it(`uses ${isWindows ? 'PowerShell' : 'sh'}`, () => {
    expect(shell.name).toBe(isWindows ? 'PowerShell' : 'sh');
  });

  it('captures output and exit code 0, and streams output live', async () => {
    const { promise, chunks } = run('echo hello-heph');
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello-heph');
    expect(chunks.join('')).toContain('hello-heph');
  });

  it('reports non-zero exit codes', async () => {
    expect((await run('exit 3').promise).exitCode).toBe(3);
  });

  it('propagates the exit code of a failing native program', async () => {
    const { exitCode } = await run('node -e "process.exit(7)"').promise;
    expect(exitCode).toBe(7);
  });

  it('runs in the given cwd', async () => {
    const cmd = isWindows ? 'Get-ChildItem -Name' : 'ls';
    const { output } = await run(cmd, { cwd: path.join(root, 'sub') }).promise;
    expect(output).toContain('marker.txt');
  });

  it('sets CI=1 so test runners do not enter watch mode', async () => {
    const { output } = await run('node -e "console.log(process.env.CI)"').promise;
    expect(output.trim()).toBe('1');
  });

  it('kills a command that runs too long', async () => {
    const result = await run('node -e "setTimeout(()=>{}, 60000)"', { timeoutMs: 1500 }).promise;
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(result.durationMs).toBeLessThan(15_000);
  });

  it('Ctrl+C (abort) kills the command', async () => {
    const controller = new AbortController();
    const { promise } = run('node -e "setTimeout(()=>{}, 60000)"', { signal: controller.signal });
    setTimeout(() => controller.abort(), 800);
    expect(await promise).toMatchObject({ aborted: true, exitCode: null });
  });

  it('handles quotes and special characters without breaking', async () => {
    const { output } = await run(`echo "it's a \\"test\\" & more"`).promise;
    expect(output).toContain("it's a");
  });
});
