import { Command, Option } from 'commander';
import { PERMISSION_MODES, READ_POLICIES } from '../permissions/PermissionMode.js';
import { VERSION } from '../version.js';

/** Options available on every command. */
export interface GlobalOptions {
  readonly profile?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** Workspace folder (default: current directory). Tools can only access files inside it. */
  readonly cwd?: string;
  /** Permission mode: read-only | ask | auto-edit | full-auto. */
  readonly mode?: string;
  /** Whether reading files asks first: ask | auto. */
  readonly reads?: string;
}

/**
 * What the CLI can do. The program only parses arguments and calls these.
 * The real implementations live in container.ts, and tests pass fakes.
 */
export interface ChatOptions extends GlobalOptions {
  /** -c: continue the most recent session. */
  readonly continue?: boolean;
  /** --resume <id>: continue a specific session. */
  readonly resume?: string;
}

export interface RunOptions extends GlobalOptions {
  /** Machine-readable output: one JSON object per line (events + final result). */
  readonly json?: boolean;
}

export interface CliActions {
  chat(options: ChatOptions): Promise<void>;
  models(options: GlobalOptions): Promise<void>;
  /** One task, then exit. Resolves with the process exit code. */
  run(task: string, options: RunOptions): Promise<number>;
  init(options: GlobalOptions & { readonly force?: boolean }): Promise<void>;
  config(options: GlobalOptions): Promise<void>;
  sessions(options: GlobalOptions): Promise<void>;
}

/**
 * Builds the CLI definition.
 *
 * Kept separate from index.ts (which actually *runs* it) so tests can create a
 * program, feed it arguments, and inspect the output without spawning a process.
 *   program.ts = "what commands exist"   index.ts = "start the process".
 */
export function createProgram(actions: CliActions): Command {
  const program = new Command();

  program
    .name('heph')
    .description(
      'A small, safe coding agent for your terminal.\n' +
        'Works with OpenAI or a local LLM via LM Studio, and asks before it changes anything.',
    )
    .version(VERSION, '-v, --version', 'print the heph version')
    .option('-p, --profile <name>', 'LLM profile from your config (built-in: local, openai)')
    .option('-m, --model <id>', 'model id to use (overrides the profile; "auto" = first available)')
    .option('--base-url <url>', 'OpenAI-compatible API base URL (overrides the profile)')
    .option('-C, --cwd <dir>', 'project folder to work in (default: current directory)')
    .addOption(
      new Option('--mode <mode>', 'what heph may do without asking (default: ask)').choices(
        PERMISSION_MODES,
      ),
    )
    .addOption(
      new Option(
        '--reads <policy>',
        'ask before reading files, or read automatically (default: ask)',
      ).choices(READ_POLICIES),
    )
    .option('-c, --continue', 'continue the most recent session in this folder')
    .option('--resume <id>', 'resume a saved session (see `heph sessions`)')
    .action(async (options: ChatOptions) => {
      await actions.chat(options);
    });

  program
    .command('models')
    .description('list the models available on the selected profile')
    .action(async (_options: unknown, command: Command) => {
      await actions.models(command.optsWithGlobals<GlobalOptions>());
    });

  program
    .command('run')
    .description(
      'do ONE task and exit (scriptable). Piped input is added as context:\n' +
        '  cat error.log | heph run "explain this error"',
    )
    .argument('<task...>', 'what heph should do')
    .option('--json', 'print machine-readable JSON lines instead of formatted output')
    .addHelpText(
      'after',
      '\nExit codes: 0 done · 1 error · 2 stopped (max steps) · 130 interrupted (Ctrl+C)\n' +
        'Without a terminal nobody can approve changes: use --mode auto-edit (and --reads auto) if needed.',
    )
    .action(async (task: string[], _options: unknown, command: Command) => {
      process.exitCode = await actions.run(task.join(' '), command.optsWithGlobals<RunOptions>());
    });

  program
    .command('init')
    .description('set up this project for heph (HEPH.md rules + .heph/config.json)')
    .option('-f, --force', 'overwrite existing files')
    .action(async (_options: unknown, command: Command) => {
      await actions.init(command.optsWithGlobals());
    });

  program
    .command('config')
    .description('show the effective configuration and where it came from (secrets hidden)')
    .action(async (_options: unknown, command: Command) => {
      await actions.config(command.optsWithGlobals<GlobalOptions>());
    });

  program
    .command('sessions')
    .description('list saved chat sessions for this folder (continue one with --resume <id>)')
    .action(async (_options: unknown, command: Command) => {
      await actions.sessions(command.optsWithGlobals<GlobalOptions>());
    });

  return program;
}
