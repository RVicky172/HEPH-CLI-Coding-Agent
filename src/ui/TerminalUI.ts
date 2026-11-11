import readline from 'node:readline';
import chalk from 'chalk';
import type { AgentEvent } from '../core/agent/AgentEvents.js';
import {
  grantScope,
  type ApprovalRequest,
  type RiskLevel,
} from '../permissions/ApprovalRequest.js';
import type { ApprovalAnswer, Approver } from '../permissions/Approver.js';
import {
  MODE_DESCRIPTIONS,
  type PermissionMode,
  type ReadPolicy,
} from '../permissions/PermissionMode.js';
import { formatError } from './formatError.js';
import { PasteAwareLineReader, type UserMessageInput } from './input/PasteAwareLineReader.js';
import { createHammerSpinner } from './render/HammerSpinner.js';
import { renderLogo } from './render/logo.js';
import { commandIcon, toolStyle } from './render/styles.js';
import { createMarkdownRenderer } from './render/markdown.js';
import { Spinner } from './render/Spinner.js';
import {
  band,
  colors,
  rule,
  shortenMiddle,
  truncate,
  type Theme,
  userBadge,
  visibleLength,
} from './render/theme.js';
import { TurnRenderer } from './render/TurnRenderer.js';
import type { InputSource, InterruptSource, OutputSink } from './UserInterface.js';

export interface BannerInfo {
  readonly version: string;
  readonly profile: string;
  readonly model: string;
  readonly baseURL: string;
  readonly workspace: string;
  readonly mode: PermissionMode;
  readonly reads: ReadPolicy;
  readonly shell: string;
  /** Project instructions file that was loaded (HEPH.md / AGENTS.md). */
  readonly instructions?: string;
  /** e.g. "18.7k tokens (detected)" */
  readonly context?: string;
  readonly tools: readonly { readonly name: string; readonly risk: RiskLevel }[];
}

/** What the input box shows. Provided by the container (it knows the session). */
export interface InputStatus {
  readonly mode: PermissionMode;
  readonly model: string;
  /** e.g. "ctx 23%" */
  readonly context?: string;
}

/** A slash command for suggestions and Tab completion. */
export interface Completion {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly args?: readonly { readonly value: string; readonly description: string }[];
}

interface Suggestion {
  /** Text Tab inserts, e.g. "/mode " or "/mode auto-edit". */
  readonly insert: string;
  readonly label: string;
  readonly description: string;
}

const PROMPT_PLAIN = '❯ ';
const BOX_PROMPT = `${chalk.hex(colors.border)('╰─')}${chalk.bold.cyan('❯ ')}`;
const BOX_PROMPT_WIDTH = 4; // "╰─❯ "
const MAX_BUBBLE_LINES = 8;
const MAX_SUGGESTIONS = 7;

/**
 * The real terminal: readline for input, chalk for colour.
 * The only class that knows about stdin/stdout. It delegates turn rendering
 * to TurnRenderer, and implements Approver: the y/a/n/f question.
 */
export class TerminalUI implements InputSource, OutputSink, InterruptSource, Approver {
  readonly #rl: readline.Interface;
  readonly #lines: AsyncIterator<string>;
  readonly #pasteReader: PasteAwareLineReader;
  readonly #out: NodeJS.WriteStream;
  readonly #interactive: boolean;
  readonly #theme: Theme;
  readonly #renderer: TurnRenderer;
  #interruptHandler: (() => void) | undefined;
  #status: (() => InputStatus) | undefined;
  #completions: readonly Completion[] = [];
  /** A read that was abandoned (Ctrl+C during a question). The next read reuses it, so no line is lost. */
  #pendingRead: Promise<UserMessageInput | null> | undefined;
  // slash-command suggestion popup state
  #inMainPrompt = false;
  #suggestionRows = 0;
  #reservedRows = 0;

  constructor(
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
  ) {
    this.#out = output;
    this.#interactive = Boolean(input.isTTY);
    this.#rl = readline.createInterface({
      input,
      output,
      terminal: this.#interactive,
      historySize: 200, // ↑ / ↓ recall earlier messages
      completer: (line: string) => this.#complete(line), // Tab completes slash commands
    });
    // The async iterator BUFFERS lines, so piped input (echo "hi" | heph) isn't lost
    // while we're busy streaming an answer.
    this.#lines = this.#rl[Symbol.asyncIterator]();
    // In a real terminal, a multi-line paste must become ONE message, not one per line.
    this.#pasteReader = new PasteAwareLineReader(this.#lines);

    this.#theme = {
      backgrounds: Boolean(output.isTTY) && chalk.level >= 2,
      width: () => output.columns ?? 100,
    };
    const write = (text: string) => this.#out.write(text);
    const width = Math.min(Math.max((output.columns ?? 100) - 4, 40), 110);
    const useHammer =
      Boolean(output.isTTY) && process.env.HEPH_SPINNER !== 'simple' && chalk.level >= 1;
    this.#renderer = new TurnRenderer({
      write,
      renderMarkdown: createMarkdownRenderer(width),
      spinner: useHammer
        ? createHammerSpinner(write, chalk.dim)
        : new Spinner(write, { enabled: Boolean(output.isTTY), style: chalk.dim }),
      theme: this.#theme,
      status: () => {
        const s = this.#status?.();
        return s ? `${s.model} · ${s.mode}` : '';
      },
    });

    // Ctrl+C: interrupt the running turn (or pending question) if there is one, otherwise quit.
    this.#rl.on('SIGINT', () => {
      if (this.#interruptHandler) this.#interruptHandler();
      else this.close();
    });

    // Live slash-command suggestions while typing "/…". readline handles the key
    // first; we redraw the popup right after.
    if (this.#interactive) {
      input.on('keypress', () => setImmediate(() => this.#refreshSuggestions()));
    }
  }

  /** What to show in the input box and turn headers (mode, model). */
  setStatus(provider: () => InputStatus): void {
    this.#status = provider;
  }

  setCompletions(completions: readonly Completion[]): void {
    this.#completions = completions;
  }

  // ── banner ─────────────────────────────────────────────────────────────────
  banner(info: BannerInfo): void {
    const facts: [string, string][] = [
      ['model', chalk.cyan(info.model)],
      ['workspace', shortenMiddle(info.workspace, 48)],
      ['mode', `${modeLabel(info.mode)} ${chalk.dim(MODE_DESCRIPTIONS[info.mode])}`],
      [
        'reads',
        info.reads === 'ask'
          ? `${chalk.green.bold('ask')} ${chalk.dim('first read asks · "a" = whole session')}`
          : `${chalk.yellow.bold('auto')} ${chalk.dim('reads without asking')}`,
      ],
      [
        'tools',
        info.tools
          .map((t) => {
            const st = toolStyle(t.name);
            return `${chalk.hex(st.color)(st.icon)} ${chalk.dim(st.done.toLowerCase())}`;
          })
          .join('  ') + chalk.dim(`  (${info.shell})`),
      ],
      ['profile', `${info.profile} ${chalk.dim(info.baseURL.replace(/^https?:\/\//, ''))}`],
      ...(info.context ? ([['context', info.context]] as [string, string][]) : []),
      [
        'project',
        info.instructions
          ? `${chalk.green('✓')} ${info.instructions} ${chalk.dim('rules loaded')}`
          : chalk.dim('no HEPH.md · run `heph init`'),
      ],
    ];
    const factLines = facts.map(([k, v]) => `${chalk.dim(k.padEnd(10))} ${v}`);
    const tips = chalk.dim(
      `   ${chalk.cyan('/')} commands   ${chalk.cyan('Tab')} complete   ${chalk.cyan('↑↓')} history   ${chalk.cyan('Ctrl+C')} stop   ${chalk.cyan('/exit')} quit`,
    );

    if (!this.#theme.backgrounds) {
      const logo = renderLogo(this.#out.isTTY ? this.#out.columns : undefined, info.version);
      this.#renderer.message(
        ['', logo, '', ...factLines.map((l) => `  ${l}`), '', tips].join('\n'),
      );
      return;
    }

    const columns = this.#out.columns ?? 100;
    const boxWidth = Math.min(columns - 1, 100);
    const inner = boxWidth - 4;
    const logoLines = renderLogo(columns, info.version)
      .split('\n')
      .map((l) => l.replace(/^ {2}/, ''));
    const sideBySide = inner >= 34 + 50;
    const rows: string[] = [];
    if (sideBySide) {
      const height = Math.max(logoLines.length, factLines.length);
      const factTop = Math.max(0, Math.floor((height - factLines.length) / 2));
      for (let i = 0; i < height; i++) {
        const left = padTo(logoLines[i] ?? '', 35);
        const right = factLines[i - factTop] ?? '';
        rows.push(left + truncate(right, inner - 35));
      }
    } else {
      rows.push(...logoLines, '', ...factLines.map((l) => truncate(l, inner)));
    }

    const border = chalk.hex(colors.border);
    const out = [
      '',
      border(`╭${'─'.repeat(boxWidth - 2)}╮`),
      `${border('│')}${' '.repeat(boxWidth - 2)}${border('│')}`,
      ...rows.map((r) => `${border('│')} ${padTo(r, inner)} ${border('│')}`),
      `${border('│')}${' '.repeat(boxWidth - 2)}${border('│')}`,
      border(`╰${'─'.repeat(boxWidth - 2)}╯`),
      tips,
    ];
    this.#renderer.message(out.join('\n'));
  }

  // ── InputSource ────────────────────────────────────────────────────────────
  async readLine(): Promise<string | null> {
    if (!this.#interactive) {
      // Piped input (echo "..." | heph): every line is its own message, by design.
      const { value, done } = await this.#lines.next();
      if (done) return null;
      this.#out.write(`\n${PROMPT_PLAIN}${value}\n`); // echo it so the transcript is readable
      return value;
    }

    // ╭─ ask · qwen3 ──────────────────────────── / commands · ↑ history
    // ╰─❯ █
    this.#out.write(`\n${this.#boxTop()}\n`);
    this.#rl.setPrompt(BOX_PROMPT);
    this.#reservedRows = 0;
    this.#inMainPrompt = true;
    this.#rl.prompt();
    let message: UserMessageInput | null;
    try {
      message = await this.#readMessage();
    } finally {
      this.#inMainPrompt = false;
    }
    if (message === null) return null;
    this.#replaceInputWithBubble(message);
    return message.text;
  }

  // ── Approver ───────────────────────────────────────────────────────────────
  async ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> {
    this.#renderer.preview(request);

    if (!this.#interactive) {
      this.#renderer.message(
        chalk.yellow(
          '  ⚠ Not run: no interactive terminal to ask. (Use --mode, or --reads auto for reading.)',
        ),
      );
      return { decision: 'deny', reason: 'non_interactive' };
    }

    const isRead = request.risk === 'read';
    const isCommand = request.preview.kind === 'command';
    const dangerous = request.preview.kind === 'command' && request.preview.warnings.length > 0;
    const always = isRead
      ? 'allow all reads this session'
      : `always for ${grantScope(request).label}`;
    const options = [
      `${chalk.bold.green('y')} yes`,
      ...(dangerous ? [] : [`${chalk.bold.cyan('a')} ${always}`]),
      `${chalk.bold.red('n')} no`,
      `${chalk.bold.yellow('f')} no, with feedback`,
    ].join(chalk.dim(' · '));

    const tool = toolStyle(request.toolName);
    const title = `${chalk.bold('⚑ heph wants to')} ${chalk.hex(tool.color).bold(`${tool.icon} ${tool.intent}`)}`;
    this.#out.write(
      `${band(this.#theme, `  ${title}`, dangerous ? colors.dangerBg : colors.approvalBg, '#fff3d6')}\n`,
    );

    const question = isRead ? 'Allow?' : isCommand ? 'Run this command?' : 'Apply this change?';
    for (;;) {
      const answer = await this.#question(
        `  ${chalk.bold(question)} ${options} ${chalk.dim('›')} `,
        signal,
      );
      if (answer === null) return { decision: 'deny' }; // Ctrl+C or end of input
      switch (answer.trim().toLowerCase()) {
        case 'y':
        case 'yes':
          return { decision: 'allow' };
        case 'a':
        case 'always':
          return dangerous ? { decision: 'allow' } : { decision: 'allow_session' };
        case 'n':
        case 'no':
          return { decision: 'deny' };
        case 'f':
        case 'feedback': {
          const feedback = await this.#question(
            `  ${chalk.yellow('What should heph do instead?')} ${chalk.dim('›')} `,
            signal,
          );
          return feedback?.trim()
            ? { decision: 'deny', feedback: feedback.trim() }
            : { decision: 'deny' };
        }
        default:
          this.#renderer.message(chalk.dim(`  Please answer y${dangerous ? '' : ', a'}, n or f.`));
      }
    }
  }

  show(request: ApprovalRequest, note: string): void {
    this.#renderer.preview(request);
    this.#renderer.message(chalk.dim(`  ${note}`));
  }

  /** Live output from a running tool (e.g. a command). */
  toolProgress(callId: string, text: string): void {
    this.#renderer.progress(callId, text);
  }

  // ── InterruptSource ────────────────────────────────────────────────────────
  onInterrupt(handler: () => void): () => void {
    this.#interruptHandler = handler;
    return () => {
      if (this.#interruptHandler === handler) this.#interruptHandler = undefined;
    };
  }

  // ── OutputSink ─────────────────────────────────────────────────────────────
  render(event: AgentEvent): void {
    this.#renderer.render(event);
  }

  info(message: string): void {
    this.#renderer.message(message);
  }

  warn(message: string): void {
    this.#renderer.message(chalk.yellow(`⚠ ${message}`));
  }

  error(error: unknown): void {
    this.#renderer.message(formatError(error));
  }

  close(): void {
    this.#rl.close();
  }

  // ── input box + bubble ─────────────────────────────────────────────────────
  #boxTop(): string {
    const border = chalk.hex(colors.border);
    const status = this.#status?.();
    const left = status
      ? `${border('╭─')} ${modeLabel(status.mode)} ${chalk.dim('·')} ${chalk.dim(status.model)}${status.context ? ` ${chalk.dim('·')} ${contextColor(status.context)}` : ''} `
      : `${border('╭─')} `;
    const hint = ` ${chalk.dim(`${chalk.cyan('/')} commands · ${chalk.cyan('↑')} history`)}`;
    const columns = this.#out.columns ?? 100;
    // Never wrap the top line: the erase arithmetic below assumes it is one row.
    if (visibleLength(left + hint) + 4 > columns - 1) return truncate(left, columns - 2);
    return `${left}${rule(this.#theme, visibleLength(left) + visibleLength(hint))}${hint}`;
  }

  /**
   * After Enter, erase the input box (top line + echoed text) and print the
   * message again as a coloured "you" bubble, so the transcript shows clearly
   * who said what.
   */
  #replaceInputWithBubble(message: UserMessageInput): void {
    const columns = Math.max(20, this.#out.columns ?? 100);
    const lines = message.text.split('\n');
    const echoedRows = lines.reduce(
      (rows, line, i) =>
        rows +
        Math.max(1, Math.ceil(((i === 0 ? BOX_PROMPT_WIDTH : 0) + visibleLength(line)) / columns)),
      0,
    );
    // Move up over the echoed rows + the box top line, then clear to the end of the screen.
    this.#out.write(`\x1b[${echoedRows + 1}A\r\x1b[0J`);
    this.#suggestionRows = 0;
    this.#writeBubble(message);
  }

  /** Show a message as the "you" bubble without an input box (used by `heph run`). */
  showUserMessage(text: string): void {
    this.#out.write('\n');
    this.#writeBubble({ text, lineCount: 1 });
  }

  #writeBubble(message: UserMessageInput): void {
    const lines = message.text.split('\n');
    const badge = userBadge(this.#theme);
    const indent = ' '.repeat(visibleLength(badge) + 2);
    const shown = lines.slice(0, MAX_BUBBLE_LINES);
    const bubble = shown.map((line, i) =>
      band(this.#theme, `${i === 0 ? ` ${badge} ` : indent}${line}`, colors.userBg, colors.userFg),
    );
    if (lines.length > MAX_BUBBLE_LINES) {
      bubble.push(
        band(
          this.#theme,
          chalk.dim(
            `${indent}… ${lines.length - MAX_BUBBLE_LINES} more lines (pasted ${lines.length} lines)`,
          ),
          colors.userBg,
        ),
      );
    } else if (message.lineCount > 1) {
      bubble.push(
        band(this.#theme, chalk.dim(`${indent}(pasted ${message.lineCount} lines)`), colors.userBg),
      );
    }
    this.#out.write(`${bubble.join('\n')}\n`);
  }

  // ── slash suggestions ──────────────────────────────────────────────────────
  /**
   * Draws the suggestion list UNDER the prompt without moving the cursor:
   *   ESC 7 (save cursor) → down one row → clear below → draw → ESC 8 (restore).
   * The first time, it prints blank lines and moves back up. That makes room
   * (scrolling the screen if the prompt is on the last row), so "restore"
   * lands on the right spot.
   */
  #refreshSuggestions(): void {
    if (!this.#inMainPrompt) return;
    const line = this.#rl.line ?? '';
    const columns = this.#out.columns ?? 100;
    const items = BOX_PROMPT_WIDTH + line.length < columns - 1 ? this.#suggestionsFor(line) : [];
    if (items.length === 0) {
      this.#clearSuggestions();
      return;
    }
    const shown = items.slice(0, MAX_SUGGESTIONS);
    const rows = shown.length + (items.length > MAX_SUGGESTIONS ? 1 : 0);
    if (rows > this.#reservedRows) {
      this.#out.write(`${'\n'.repeat(rows)}\x1b[${rows}A`);
      readline.cursorTo(this.#out, BOX_PROMPT_WIDTH + (this.#rl.cursor ?? line.length));
      this.#reservedRows = rows;
    }
    const labelWidth = Math.max(...shown.map((s) => s.label.length)) + 2;
    const text = shown.map((s, i) => {
      const marker = i === 0 ? chalk.cyan('›') : ' ';
      const body = `  ${marker} ${chalk.hex('#ffb37a')(commandIcon(s.insert.slice(1).split(' ')[0] ?? ''))} ${(i === 0 ? chalk.bold.cyan : chalk.cyan)(s.label.padEnd(labelWidth))}${chalk.dim(s.description)}`;
      return band(
        this.#theme,
        truncate(body, columns - 2),
        i === 0 ? colors.suggestSelectedBg : colors.suggestBg,
      );
    });
    if (items.length > MAX_SUGGESTIONS) {
      text.push(
        band(
          this.#theme,
          chalk.dim(`    … ${items.length - MAX_SUGGESTIONS} more`),
          colors.suggestBg,
        ),
      );
    }
    this.#out.write(`\x1b7\x1b[1B\r\x1b[0J${text.join('\n')}\x1b8`);
    this.#suggestionRows = rows;
  }

  #clearSuggestions(): void {
    if (!this.#suggestionRows) return;
    this.#out.write('\x1b7\x1b[1B\r\x1b[0J\x1b8');
    this.#suggestionRows = 0;
  }

  #suggestionsFor(line: string): Suggestion[] {
    if (!line.startsWith('/') || line.includes('\n')) return [];
    const [name = '', ...rest] = line.slice(1).split(' ');
    if (rest.length === 0) {
      return this.#completions
        .filter((c) => c.name.startsWith(name.toLowerCase()))
        .map((c) => ({
          insert: c.args?.length ? `/${c.name} ` : `/${c.name}`,
          label: `/${c.name}${c.usage ? ` ${c.usage}` : ''}`,
          description: c.description,
        }));
    }
    const entry = this.#completions.find((c) => c.name === name.toLowerCase());
    const arg = rest.join(' ');
    return (entry?.args ?? [])
      .filter((a) => a.value.startsWith(arg))
      .map((a) => ({ insert: `/${name} ${a.value}`, label: a.value, description: a.description }));
  }

  /** readline completer: Tab inserts the first (highlighted) suggestion. */
  #complete(line: string): [string[], string] {
    const first = this.#suggestionsFor(line)[0];
    return first ? [[first.insert], line] : [[], line];
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  async #question(prompt: string, signal: AbortSignal): Promise<string | null> {
    this.#rl.setPrompt(prompt);
    this.#rl.prompt();
    try {
      const message = await this.#readMessage(signal);
      return message?.text ?? null;
    } finally {
      this.#rl.setPrompt(BOX_PROMPT);
    }
  }

  /** Reads one message. With a signal, resolves `null` on abort WITHOUT losing the pending line. */
  async #readMessage(signal?: AbortSignal): Promise<UserMessageInput | null> {
    const read = this.#pendingRead ?? this.#pasteReader.read();
    this.#pendingRead = read;
    if (signal?.aborted) return null;

    const aborted = signal
      ? new Promise<'aborted'>((resolve) =>
          signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
        )
      : undefined;
    const result = await (aborted ? Promise.race([read, aborted]) : read);
    if (result === 'aborted') {
      this.#out.write('\n');
      return null; // keep #pendingRead: the next read() will receive that line
    }
    this.#pendingRead = undefined;
    return result;
  }
}

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'read-only':
      return chalk.blue.bold(mode);
    case 'ask':
      return chalk.green.bold(mode);
    case 'auto-edit':
      return chalk.yellow.bold(mode);
    case 'full-auto':
      return chalk.red.bold(mode);
  }
}

/** "ctx 23%" green, yellow from 60 %, red from 85 %. */
function contextColor(text: string): string {
  const pct = Number(/(\d+)%/.exec(text)?.[1] ?? 0);
  return (pct >= 85 ? chalk.red : pct >= 60 ? chalk.yellow : chalk.green)(text);
}
