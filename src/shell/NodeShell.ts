import { spawn, type ChildProcess } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import type { Shell, ShellResult, ShellRunOptions } from './Shell.js';

/** Keep at most this much output in memory (head + tail), even for very chatty commands. */
const MAX_CAPTURE_CHARS = 400_000;

/**
 * Runs commands with the platform's shell:
 *   Windows → PowerShell (what the user's terminal uses)
 *   others  → /bin/sh
 *
 * Commands run NON-INTERACTIVELY: stdin is closed and CI=1 is set, so test
 * runners don't start watch mode and tools don't wait for input that never comes.
 */
export class NodeShell implements Shell {
  readonly name = process.platform === 'win32' ? 'PowerShell' : 'sh';

  run(command: string, options: ShellRunOptions): Promise<ShellResult> {
    const startedAt = Date.now();
    const child = this.#spawn(command, options.cwd);

    return new Promise((resolve) => {
      const capture = new OutputCapture();
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const onData = (data: Buffer) => {
        const text = stripVTControlCharacters(data.toString('utf8'));
        capture.add(text);
        options.onOutput?.(text);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);
      const onAbort = () => {
        aborted = true;
        killTree(child);
      };
      options.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        resolve({
          exitCode: timedOut || aborted ? null : exitCode,
          output: capture.text(),
          timedOut,
          aborted,
          durationMs: Date.now() - startedAt,
        });
      };
      child.on('error', (error) => {
        capture.add(`\n[failed to start: ${error.message}]`);
        finish(127);
      });
      child.on('close', (code) => finish(code));

      if (options.signal.aborted) onAbort();
    });
  }

  #spawn(command: string, cwd: string): ChildProcess {
    const env = {
      ...process.env,
      CI: '1', // test runners: run once, no watch mode, no interactive prompts
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0', // never hang waiting for a git password
    };

    if (process.platform === 'win32') {
      // -EncodedCommand (UTF-16LE base64) avoids every quoting problem.
      // The wrapper forces UTF-8 output and propagates the real exit code.
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        '$hephOk = $?',
        'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
        'if (-not $hephOk) { exit 1 }',
      ].join('\n');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      return spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded,
        ],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    }

    // detached → own process group, so we can kill the whole tree with -pid.
    return spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  }
}

/** Kill the process AND everything it started (e.g. npm → node → vitest workers). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** Keeps the first and last part of huge outputs. Errors are usually at the end. */
class OutputCapture {
  #head = '';
  #tail = '';
  #dropped = 0;

  add(text: string): void {
    if (this.#head.length < MAX_CAPTURE_CHARS / 4) {
      this.#head += text;
      return;
    }
    this.#tail += text;
    const max = (MAX_CAPTURE_CHARS * 3) / 4;
    if (this.#tail.length > max) {
      this.#dropped += this.#tail.length - max;
      this.#tail = this.#tail.slice(-max);
    }
  }

  text(): string {
    if (!this.#dropped) return this.#head + this.#tail;
    return `${this.#head}\n[… ${this.#dropped} characters of output dropped …]\n${this.#tail}`;
  }
}
