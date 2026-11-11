export interface ShellRunOptions {
  /** Absolute working directory (already validated to be inside the workspace). */
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Ctrl+C: kills the process (and its children). */
  readonly signal: AbortSignal;
  /** Called with output chunks as they arrive (stdout and stderr interleaved). */
  readonly onOutput?: (chunk: string) => void;
}

export interface ShellResult {
  /** null when the process was killed (timeout or Ctrl+C). */
  readonly exitCode: number | null;
  /** stdout + stderr in arrival order, ANSI colour codes removed. */
  readonly output: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
}

/**
 * Runs one command line. The port between the run_command tool and the OS
 * (Dependency Inversion): tests use a FakeShell, production uses NodeShell.
 */
export interface Shell {
  /** "PowerShell" or "sh": told to the model so it writes the right syntax. */
  readonly name: string;
  run(command: string, options: ShellRunOptions): Promise<ShellResult>;
}
