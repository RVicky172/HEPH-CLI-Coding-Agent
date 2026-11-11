import { z } from 'zod';
import type { ActionPreview } from '../../permissions/ApprovalRequest.js';
import type { Shell } from '../../shell/Shell.js';
import { WorkspaceError } from '../../workspace/WorkspaceError.js';
import type { Tool, ToolContext, ToolResult } from '../Tool.js';
import { detectDangers } from './DangerousCommandDetector.js';

const schema = z.object({
  command: z.string().min(1).describe('The command line to run.'),
  purpose: z
    .string()
    .optional()
    .describe('One short sentence telling the user WHY you run it, e.g. "Run the unit tests".'),
  cwd: z.string().default('.').describe('Folder to run in, relative to the workspace root.'),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .default(120)
    .describe('Kill the command after this many seconds (default 120).'),
});
type Args = z.infer<typeof schema>;

/**
 * Runs a shell command (tests, builds, linters, git status…).
 *
 * Risk = execute: in the default mode the user ALWAYS sees the exact command
 * and approves it. Unlike file tools, PathGuard can't confine a command (it
 * could `cd ..`), so the human is the real safety check here.
 */
export class RunCommandTool implements Tool<Args> {
  readonly name = 'run_command';
  readonly description: string;
  readonly schema = schema;
  readonly risk = 'execute' as const;
  readonly #shell: Shell;

  constructor(shell: Shell) {
    this.#shell = shell;
    this.description =
      `Run a ${shell.name} command in the workspace and return its exit code and output. ` +
      'Use it to run tests, builds, linters, type checks, or read-only git commands. ' +
      'The user must approve every command. Commands run non-interactively (no input possible) ' +
      'with CI=1. Never start servers or watch modes: they never exit and will time out.';
  }

  describe(args: Args): string {
    return args.command.length > 80 ? `${args.command.slice(0, 79)}…` : args.command;
  }

  async preview(args: Args, { workspace }: ToolContext): Promise<ActionPreview> {
    const { relative } = await this.#resolveCwd(args, workspace);
    return {
      kind: 'command',
      command: args.command,
      cwd: relative,
      warnings: detectDangers(args.command),
      ...(args.purpose && { purpose: args.purpose }),
    };
  }

  async execute(args: Args, { workspace, signal, onProgress }: ToolContext): Promise<ToolResult> {
    const { absolute } = await this.#resolveCwd(args, workspace);
    const result = await this.#shell.run(args.command, {
      cwd: absolute,
      timeoutMs: args.timeoutSeconds * 1000,
      signal,
      ...(onProgress && { onOutput: onProgress }),
    });

    const seconds = (result.durationMs / 1000).toFixed(1);
    const body = result.output.trim() || '(no output)';

    if (result.aborted) {
      return {
        ok: false,
        output: `$ ${args.command}\nCANCELLED by the user after ${seconds}s.\n\n${body}`,
        summary: 'cancelled',
      };
    }
    if (result.timedOut) {
      return {
        ok: false,
        output:
          `$ ${args.command}\nTIMED OUT after ${args.timeoutSeconds}s: the process was killed. ` +
          `If it is a server or watch mode, it never exits; do not run it this way.\n\n${body}`,
        summary: `timed out (${args.timeoutSeconds}s)`,
      };
    }
    const ok = result.exitCode === 0;
    return {
      ok,
      output: `$ ${args.command}\nexit code ${result.exitCode} · ${seconds}s\n\n${body}`,
      summary: `exit ${result.exitCode} · ${countLines(body)} lines`,
    };
  }

  async #resolveCwd(args: Args, workspace: ToolContext['workspace']) {
    const resolved = workspace.resolve(args.cwd);
    const info = await workspace.stat(args.cwd);
    if (!info?.isDirectory)
      throw new WorkspaceError(`cwd "${args.cwd}" is not a folder in the workspace.`);
    return resolved;
  }
}

function countLines(text: string): number {
  return text === '(no output)' ? 0 : text.split('\n').length;
}
