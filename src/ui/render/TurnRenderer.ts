import chalk from 'chalk';
import type { AgentEvent } from '../../core/agent/AgentEvents.js';
import type { ApprovalRequest } from '../../permissions/ApprovalRequest.js';
import { formatError } from '../formatError.js';
import { renderApprovalPreview } from './DiffRenderer.js';
import { MARKS, mark, toolStyle } from './styles.js';
import { MarkdownBlockBuffer } from './MarkdownBlockBuffer.js';
import type { SpinnerLike } from './Spinner.js';
import {
  agentBadge,
  answerGutter,
  band,
  colors,
  plainTheme,
  rule,
  spread,
  truncate,
  visibleLength,
  type Theme,
} from './theme.js';

export interface TurnRendererDeps {
  readonly write: (text: string) => void;
  readonly renderMarkdown: (markdown: string) => string;
  readonly spinner: SpinnerLike;
  /** Colours/backgrounds. Default: plain (no backgrounds), which tests use. */
  readonly theme?: Theme;
  /** Shown at the right of the turn header, e.g. "qwen3 · ask". */
  readonly status?: () => string;
}

const INDENT = '  ';

/** What was printed last, to decide spacing between sections. */
type Section = 'none' | 'header' | 'reasoning' | 'tools' | 'text';

/**
 * Turns AgentEvents into a readable, clearly separated transcript:
 *
 *    ● heph                                         ← orange badge: the agent's turn
 *   ┃ ✓ read_file README.md · 50 lines · 2ms        ← dark band: what the agent DID
 *   ┃ ✓ run_command npm test · exit 0 · 3.1s
 *
 *   ▎ The README describes…                         ← orange bar: what it SAYS (Markdown)
 *     ── 2.1s · 2 steps · 1,240 in / 96 out tokens  ← stats
 *
 * Single responsibility: presentation. It knows nothing about readline or the
 * agent's internals. It receives events and writes text. Fully unit-testable.
 */
export class TurnRenderer {
  readonly #deps: TurnRendererDeps;
  readonly #theme: Theme;
  readonly #markdown = new MarkdownBlockBuffer();
  readonly #toolLabels = new Map<string, { name: string; label: string }>();
  #section: Section = 'none';
  #atLineStart = true;
  #lastTrim = '';

  constructor(deps: TurnRendererDeps) {
    this.#deps = deps;
    this.#theme = deps.theme ?? plainTheme;
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking':
        if (event.step === 1) this.#header();
        this.#spin(event.step === 1 ? 'thinking…' : 'reading the results…');
        break;

      case 'reasoning': {
        this.#deps.spinner.stop();
        const r = MARKS.reasoning;
        if (this.#section !== 'reasoning') {
          this.#gap();
          // ✻ the model's private reasoning: dim and italic, so it never looks like the answer
          this.#write(`${INDENT}${chalk.hex(r.color)(r.icon)} `);
          this.#section = 'reasoning';
        }
        this.#write(chalk.hex(r.color).dim.italic(event.delta.replace(/\n+/g, `\n${INDENT}  `)));
        break;
      }

      case 'text':
        this.#deps.spinner.stop();
        for (const block of this.#markdown.push(event.delta)) this.#printBlock(block);
        break;

      case 'tool_start': {
        this.#deps.spinner.stop();
        this.#flushText();
        this.#toolLabels.set(event.callId, { name: event.name, label: event.label });
        const s = toolStyle(event.name);
        this.#spin(`${chalk.hex(s.color)(`${s.icon} ${s.active}`)} ${event.label}…`);
        break;
      }

      case 'tool_end': {
        this.#deps.spinner.stop();
        if (this.#section !== 'tools') this.#gap();
        const label = this.#toolLabels.get(event.callId)?.label ?? '';
        const details = [event.summary, formatDuration(event.durationMs)]
          .filter(Boolean)
          .join(' · ');
        const outcome = event.denied ? 'denied' : event.ok ? 'ok' : 'failed';
        this.#line(this.#toolRow(event.name, label, details, outcome));
        this.#section = 'tools';
        break;
      }

      case 'compacting':
        this.#flushText();
        this.#spin(
          `${chalk.hex(MARKS.compacted.color)(`${MARKS.compacted.icon} Compacting`)} the context is filling up: summarising older turns…`,
        );
        break;

      case 'compacted': {
        this.#deps.spinner.stop();
        if (this.#section !== 'tools') this.#gap();
        const c = MARKS.compacted;
        this.#line(
          `${INDENT}${chalk.hex(c.color)(`${c.icon} Compacted`)} ${chalk.dim(
            `${event.turns} older turn${event.turns === 1 ? '' : 's'} into a summary · ${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens`,
          )}`,
        );
        this.#section = 'tools';
        break;
      }

      case 'context_trimmed': {
        // Every step of a turn is fitted again; only tell the user when something NEW happened.
        const text = event.actions.join(', ');
        if (text === this.#lastTrim) break;
        this.#lastTrim = text;
        this.#deps.spinner.stop();
        this.#endLine();
        const t = MARKS.trimmed;
        this.#line(
          `${INDENT}${chalk.hex(t.color)(`${t.icon} Trimmed`)} ${chalk.dim(`to fit the context: ${text}`)}`,
        );
        break;
      }

      case 'warning':
        this.#deps.spinner.stop();
        this.#flushText();
        this.#gap();
        this.#line(`${INDENT}${mark('warning')} ${chalk.hex(MARKS.warning.color)(event.message)}`);
        break;

      case 'turn_end': {
        this.#deps.spinner.stop();
        this.#flushText();
        // ◷ 2.1s · ↻ 2 steps · ⇅ 1,240 in / 96 out · ◔ ctx 23% of 61k
        const parts = [`${mark('time')} ${(event.durationMs / 1000).toFixed(1)}s`];
        if (event.steps > 1) parts.push(`${mark('steps')} ${event.steps} steps`);
        if (event.usage) {
          const { inputTokens, outputTokens } = event.usage;
          parts.push(
            `${mark('tokens')} ${inputTokens.toLocaleString('en-US')} in / ${outputTokens.toLocaleString('en-US')} out`,
          );
        }
        if (event.finishReason === 'length') {
          parts.push(`${mark('warning')} ${chalk.yellow('answer cut off (max tokens)')}`);
        }
        if (event.context) {
          parts.push(formatContext(event.context.usedTokens, event.context.limitTokens));
        }
        const stats = parts.join(chalk.dim(' · '));
        this.#gap();
        this.#line(
          this.#theme.backgrounds
            ? spread(this.#theme, '', chalk.dim(stats))
            : INDENT + chalk.dim(stats),
        );
        this.#endTurn();
        break;
      }

      case 'interrupted':
        this.#deps.spinner.stop();
        this.#flushText();
        this.#gap();
        this.#line(
          `${INDENT}${mark('interrupted')} ${chalk.hex(MARKS.interrupted.color)('Interrupted')}`,
        );
        this.#endTurn();
        break;

      case 'error':
        this.#deps.spinner.stop();
        this.#flushText();
        this.#gap();
        this.#line(indentLines(formatError(event.error), INDENT));
        this.#endTurn();
        break;
    }
  }

  /**
   * Show what a tool is about to do (diff or command box). Called by the
   * approval flow, between tool_start and tool_end.
   */
  preview(request: ApprovalRequest): void {
    this.#deps.spinner.stop();
    this.#flushText();
    if (this.#section !== 'tools') this.#gap();
    this.#line(renderApprovalPreview(request, INDENT, this.#theme));
    this.#section = 'tools';
  }

  /** Live output of a running tool: shown next to the hammer (latest line only). */
  progress(callId: string, chunk: string): void {
    const last = chunk
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    if (!last) return;
    const call = this.#toolLabels.get(callId);
    const s = toolStyle(call?.name ?? '');
    const head = `${chalk.hex(s.color)(`${s.icon} ${s.active}`)} ${call?.label ?? ''}`;
    const room = Math.max(20, this.#theme.width() - visibleLength(head) - 16);
    this.#spin(
      `${head} ${chalk.dim('›')} ${last.length > room ? `${last.slice(0, room - 1)}…` : last}`,
    );
  }

  /** For messages outside a turn (slash commands, warnings). */
  message(text: string): void {
    this.#deps.spinner.stop();
    this.#endLine();
    this.#line(text);
  }

  #header(): void {
    this.#endLine();
    this.#line('');
    const badge = agentBadge(this.#theme);
    if (this.#theme.backgrounds) {
      // ● heph ──────────────────────────────── qwen3 · ask
      const status = chalk.dim(this.#deps.status?.() ?? '');
      const used = visibleLength(badge) + visibleLength(status) + 2;
      this.#line(`${badge} ${rule(this.#theme, used)} ${status}`);
    } else {
      this.#line(badge);
    }
    this.#section = 'header';
  }

  /**
   * One tool row: the tool's own icon + verb in its own colour, the target, and
   * the outcome glyph at the end (✔ done · ✘ failed · ⊘ denied).
   * Themed: aligned columns, details flush right, on a dark band:
   *   ◧ Read      README.md                                 50 lines · 2ms  ✔
   * Plain (tests, pipes): "  ◧ Read README.md · 50 lines · 2ms ✔"
   */
  #toolRow(
    name: string,
    label: string,
    details: string,
    outcome: 'ok' | 'failed' | 'denied',
  ): string {
    const s = toolStyle(name);
    const verb = outcome === 'denied' ? 'Skipped' : s.done;
    const paint = chalk.hex(s.color);
    const status = mark(outcome);
    const detailText =
      outcome === 'ok' ? chalk.dim(details) : chalk.hex(MARKS[outcome].color)(details);
    if (!this.#theme.backgrounds) {
      return `${INDENT}${paint(s.icon)} ${paint.bold(verb)} ${label} ${chalk.dim('·')} ${detailText} ${status}`;
    }
    const right = `${detailText}  ${status} `;
    const room = this.#theme.width() - visibleLength(right) - 18;
    const left = `${INDENT}${paint(s.icon)} ${paint.bold(verb.padEnd(9))} ${chalk.hex(colors.activityFg)(truncate(label, Math.max(10, room)))}`;
    return band(
      this.#theme,
      spread(this.#theme, left, right),
      colors.activityBg,
      colors.activityFg,
    );
  }

  #printBlock(block: string): void {
    const rendered = this.#deps.renderMarkdown(block);
    if (!rendered.trim()) return; // e.g. stray HTML-ish tags render to nothing: no empty lines
    const gutter = answerGutter(this.#theme);
    if (this.#section !== 'text') this.#gap();
    else this.#line(this.#theme.backgrounds ? gutter.trimEnd() : ''); // between paragraphs
    this.#line(indentLines(rendered, gutter, this.#theme.backgrounds));
    this.#section = 'text';
  }

  #flushText(): void {
    const rest = this.#markdown.flush();
    if (rest) this.#printBlock(rest);
  }

  /** One blank line between different sections (but not right after the header). */
  #gap(): void {
    this.#endLine();
    if (this.#section !== 'header' && this.#section !== 'none') this.#line('');
  }

  #endTurn(): void {
    this.#toolLabels.clear();
    this.#section = 'none';
    this.#lastTrim = '';
  }

  /**
   * Start (or update) the spinner. It draws on the CURRENT line and clears it
   * with "\r + erase line", so we must be at the start of a fresh line first.
   * Otherwise it would erase half-written text (this once wiped the model's
   * reasoning).
   */
  #spin(text: string): void {
    this.#endLine();
    this.#deps.spinner.start(text);
  }

  #line(text: string): void {
    this.#write(`${text}\n`);
  }

  #endLine(): void {
    if (!this.#atLineStart) this.#write('\n');
  }

  #write(text: string): void {
    if (!text) return;
    this.#deps.write(text);
    this.#atLineStart = text.endsWith('\n');
  }
}

/** Prefix lines. `prefixEmpty`: also prefix blank lines (keeps the answer bar continuous). */
function indentLines(text: string, prefix: string, prefixEmpty = false): string {
  return text
    .split('\n')
    .map((line) => (line || prefixEmpty ? prefix + line : line))
    .join('\n');
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 1234 → "1.2k" */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "◔ ctx 34% of 14.6k", coloured green → yellow → red as it fills up. */
export function formatContext(used: number, limit: number): string {
  const pct = Math.round((used / Math.max(1, limit)) * 100);
  const color = pct >= 85 ? chalk.red : pct >= 60 ? chalk.yellow : chalk.green;
  return `${color(`${MARKS.context.icon} ctx ${pct}%`)} of ${formatTokens(limit)}`;
}
