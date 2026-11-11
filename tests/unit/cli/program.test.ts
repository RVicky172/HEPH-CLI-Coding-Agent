import { describe, expect, it } from 'vitest';
import { createProgram, type CliActions, type GlobalOptions } from '../../../src/cli/program.js';
import { VERSION } from '../../../src/version.js';

/** Fake actions that just record what the CLI asked for. */
function fakeActions() {
  const calls: { action: keyof CliActions; options: GlobalOptions; task?: string }[] = [];
  const actions: CliActions = {
    chat: async (options) => void calls.push({ action: 'chat', options }),
    models: async (options) => void calls.push({ action: 'models', options }),
    run: async (task, options) => {
      calls.push({ action: 'run', options, task });
      return 0;
    },
    init: async (options) => void calls.push({ action: 'init', options }),
    config: async (options) => void calls.push({ action: 'config', options }),
    sessions: async (options) => void calls.push({ action: 'sessions', options }),
  };
  return { actions, calls };
}

/**
 * Runs the CLI in-process and captures what it would print.
 * `exitOverride` makes commander throw instead of calling process.exit(),
 * which would kill the test runner.
 */
async function run(args: string[], actions = fakeActions().actions) {
  let stdout = '';
  const program = createProgram(actions)
    .exitOverride()
    .configureOutput({ writeOut: (s) => (stdout += s), writeErr: () => {} });

  let exitCode: number | undefined;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    exitCode = (error as { exitCode?: number }).exitCode;
  }
  return { stdout, exitCode };
}

describe('heph CLI program', () => {
  it('prints the package.json version for --version and -v', async () => {
    expect((await run(['--version'])).stdout.trim()).toBe(VERSION);
    expect((await run(['-v'])).stdout.trim()).toBe(VERSION);
  });

  it('prints usage for --help, including the profile option and models command', async () => {
    const { stdout, exitCode } = await run(['--help']);
    expect(stdout).toContain('Usage: heph');
    expect(stdout).toContain('--profile');
    expect(stdout).toContain('models');
    expect(exitCode).toBe(0);
  });

  it('starts chat with no arguments', async () => {
    const { actions, calls } = fakeActions();
    await run([], actions);
    expect(calls).toEqual([{ action: 'chat', options: {} }]);
  });

  it('passes --profile, --model and --base-url to chat', async () => {
    const { actions, calls } = fakeActions();
    await run(['-p', 'openai', '--model', 'gpt-x', '--base-url', 'http://h:1/v1'], actions);
    expect(calls[0]).toEqual({
      action: 'chat',
      options: { profile: 'openai', model: 'gpt-x', baseUrl: 'http://h:1/v1' },
    });
  });

  it('gives `models` access to global options', async () => {
    const { actions, calls } = fakeActions();
    await run(['--profile', 'local', 'models'], actions);
    expect(calls).toEqual([{ action: 'models', options: { profile: 'local' } }]);
  });

  it('run: joins the task words and accepts global options before or after', async () => {
    const { actions, calls } = fakeActions();
    await run(['run', 'fix', 'the', 'tests', '--json', '--mode', 'auto-edit'], actions);
    expect(calls[0]).toMatchObject({
      action: 'run',
      task: 'fix the tests',
      options: { json: true, mode: 'auto-edit' },
    });
  });

  it('init --force and config are wired', async () => {
    const { actions, calls } = fakeActions();
    await run(['init', '--force'], actions);
    await run(['config', '-p', 'openai'], actions);
    expect(calls.map((c) => c.action)).toEqual(['init', 'config']);
    expect(calls[0]?.options).toMatchObject({ force: true });
    expect(calls[1]?.options).toMatchObject({ profile: 'openai' });
  });
});
