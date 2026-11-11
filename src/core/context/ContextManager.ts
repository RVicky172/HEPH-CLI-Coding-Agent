import type { Conversation } from '../conversation/Conversation.js';
import type { Message } from '../conversation/Message.js';
import type { TokenEstimator } from './TokenEstimator.js';

/** Turns the older part of a conversation into a short summary (usually by asking the model). */
export type Summarizer = (transcript: string, signal: AbortSignal) => Promise<string>;

export interface ContextManagerOptions {
  readonly estimator: TokenEstimator;
  /** Total tokens the model can see (prompt + answer). */
  readonly contextWindow: number;
  /** Tokens kept free for the model's answer. Default: min(4096, 25% of the window). */
  readonly reserveForOutput?: number;
  /** The most recent N turns are never shortened or summarised (the current turn is always one). */
  readonly keepRecentTurns?: number;
  /** Compact when the conversation fills this share of the budget. Default 0.75. */
  readonly compactAt?: number;
  readonly summarize?: Summarizer;
}

export interface ContextUsage {
  readonly usedTokens: number;
  readonly limitTokens: number;
  /** 0…1+ (can exceed 1 before fitting) */
  readonly ratio: number;
}

export interface FitResult {
  readonly messages: Message[];
  readonly estimatedTokens: number;
  /** What was done to make it fit, for the UI, e.g. "shortened 3 old tool outputs". */
  readonly actions: string[];
}

export interface CompactionResult {
  readonly turns: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export const SUMMARY_MARKER = '[Summary of the earlier conversation]';
const ELIDED = '[older tool output removed to save context; read the file again if you need it]';

/**
 * Keeps every request inside the model's context window.
 *
 * Every model call re-sends the WHOLE conversation, so a long session grows
 * until it no longer fits. Strategies, cheapest first:
 *
 *   1. fit():     NON-destructive, per request. Shorten old tool outputs (file
 *                 contents are the bulk and can be re-read). If still too big,
 *                 leave out the oldest turns.
 *   2. compact(): PERSISTENT. Ask the model to summarise the older turns and
 *                 replace them in the conversation by that summary. Costs one
 *                 extra model call, keeps the meaning.
 *
 * A "turn" = one user message + everything until the next user message
 * (assistant answers, tool calls and their results). Turns are only ever
 * removed WHOLE, so every tool call keeps its result (required by the API).
 */
export class ContextManager {
  readonly #estimator: TokenEstimator;
  readonly #window: number;
  readonly #reserve: number;
  readonly #keepRecent: number;
  readonly #compactAt: number;
  readonly #summarize: Summarizer | undefined;

  constructor(options: ContextManagerOptions) {
    this.#estimator = options.estimator;
    this.#window = options.contextWindow;
    this.#reserve =
      options.reserveForOutput ?? Math.min(4096, Math.floor(options.contextWindow * 0.25));
    this.#keepRecent = Math.max(1, options.keepRecentTurns ?? 2);
    this.#compactAt = options.compactAt ?? 0.75;
    this.#summarize = options.summarize;
  }

  get contextWindow(): number {
    return this.#window;
  }

  /** Tokens available for the prompt (window minus room for the answer). */
  get limit(): number {
    return Math.max(256, this.#window - this.#reserve);
  }

  get estimator(): TokenEstimator {
    return this.#estimator;
  }

  usage(messages: readonly Message[], extraTokens = 0): ContextUsage {
    const used = this.#estimator.messages(messages) + extraTokens;
    return { usedTokens: used, limitTokens: this.limit, ratio: used / this.limit };
  }

  // ── 1. fit (non-destructive) ───────────────────────────────────────────────
  fit(messages: readonly Message[], extraTokens = 0): FitResult {
    const actions: string[] = [];
    let current = [...messages];
    const tokens = () => this.#estimator.messages(current) + extraTokens;
    if (tokens() <= this.limit) return { messages: current, estimatedTokens: tokens(), actions };

    // a) shorten tool outputs outside the recent turns, then in all but the current turn
    for (const keep of [this.#keepRecent, 1]) {
      const { messages: shortened, count } = elideToolOutputs(current, keep);
      if (count > 0) {
        current = shortened;
        actions.push(`shortened ${count} old tool output${count === 1 ? '' : 's'}`);
      }
      if (tokens() <= this.limit) return { messages: current, estimatedTokens: tokens(), actions };
    }

    // b) leave out the oldest whole turns (never the current one)
    let dropped = 0;
    while (tokens() > this.limit) {
      const next = dropOldestTurn(current);
      if (!next) break;
      current = next;
      dropped++;
    }
    if (dropped) actions.push(`left out ${dropped} oldest turn${dropped === 1 ? '' : 's'}`);
    if (tokens() > this.limit)
      actions.push('still over the limit: the current turn alone is too big');
    return { messages: current, estimatedTokens: tokens(), actions };
  }

  // ── 2. compaction (persistent) ─────────────────────────────────────────────
  shouldCompact(messages: readonly Message[], extraTokens = 0): boolean {
    if (!this.#summarize) return false;
    if (this.usage(messages, extraTokens).ratio < this.#compactAt) return false;
    // Only worth an extra model call if the part we'd summarise is big enough to matter.
    // (Found in real use: compacting a tiny old part gave "9.4k → 9.4k" and cost 30 s.)
    const { old } = splitForCompaction(messages, this.#keepRecent);
    return old.length > 0 && this.#estimator.messages(old) >= this.limit * 0.15;
  }

  /** Summarise all but the recent turns and replace them in the conversation. */
  async compact(
    conversation: Conversation,
    signal: AbortSignal,
    keepRecent = this.#keepRecent,
  ): Promise<CompactionResult | undefined> {
    if (!this.#summarize) return undefined;
    const messages = conversation.messages();
    const { system, old, recent, oldTurns } = splitForCompaction(messages, keepRecent);
    if (old.length === 0) return undefined;

    const tokensBefore = this.#estimator.messages(messages);
    // The transcript sent to the summariser must itself fit: keep its END (most recent).
    const transcript = toTranscript(old);
    const maxChars = Math.floor(this.limit * 0.6 * 3.6);
    const summary = await this.#summarize(
      transcript.length > maxChars ? `[…]\n${transcript.slice(-maxChars)}` : transcript,
      signal,
    );

    conversation.replaceHistory([
      ...system,
      { role: 'user', content: `${SUMMARY_MARKER}\n${summary.trim()}` },
      { role: 'assistant', content: 'Understood. I will continue from this summary.' },
      ...recent,
    ]);
    return {
      turns: oldTurns,
      tokensBefore,
      tokensAfter: this.#estimator.messages(conversation.messages()),
    };
  }
}

/** Index of each message that starts a turn (a user message). */
function turnStarts(messages: readonly Message[]): number[] {
  return messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
}

function splitForCompaction(messages: readonly Message[], keepRecent: number) {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const starts = turnStarts(rest);
  const cut = starts.length > keepRecent ? (starts[starts.length - keepRecent] ?? 0) : 0;
  return {
    system,
    old: rest.slice(0, cut),
    recent: rest.slice(cut),
    oldTurns: starts.filter((s) => s < cut).length,
  };
}

function elideToolOutputs(
  messages: Message[],
  keepRecentTurns: number,
): { messages: Message[]; count: number } {
  const starts = turnStarts(messages);
  const protectFrom =
    starts.length > keepRecentTurns ? (starts[starts.length - keepRecentTurns] ?? 0) : 0;
  let count = 0;
  const out = messages.map((m, i): Message => {
    if (i >= protectFrom || m.role !== 'tool' || m.content === ELIDED || m.content.length < 400)
      return m;
    count++;
    return { ...m, content: ELIDED };
  });
  return { messages: out, count };
}

/** Remove the oldest whole turn (keeping system messages and the current turn). */
function dropOldestTurn(messages: Message[]): Message[] | undefined {
  const starts = turnStarts(messages);
  if (starts.length < 2) return undefined;
  const [first, second] = [starts[0] ?? 0, starts[1] ?? 0];
  return [...messages.slice(0, first), ...messages.slice(second)];
}

/** A readable text version of messages, for the summariser. Long tool outputs are cut. */
export function toTranscript(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      switch (m.role) {
        case 'system':
          return '';
        case 'user':
          return `USER: ${m.content}`;
        case 'assistant': {
          const calls = (m.toolCalls ?? [])
            .map((c) => `  → called ${c.name}(${c.arguments.slice(0, 200)})`)
            .join('\n');
          return [`ASSISTANT: ${m.content}`.trim(), calls].filter(Boolean).join('\n');
        }
        case 'tool':
          return `TOOL RESULT: ${m.content.length > 1500 ? `${m.content.slice(0, 1500)}… [cut]` : m.content}`;
      }
    })
    .filter(Boolean)
    .join('\n\n');
}
