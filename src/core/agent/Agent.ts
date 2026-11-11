import type { ChatRequest, LLMProvider, TokenUsage } from '../../llm/LLMProvider.js';
import type { CompactionResult, ContextManager, ContextUsage } from '../context/ContextManager.js';
import type { Conversation } from '../conversation/Conversation.js';
import type { ToolCall } from '../conversation/Message.js';
import type { AgentEvent } from './AgentEvents.js';
import type { ToolRunner } from './ToolRunner.js';

export interface AgentOptions {
  readonly provider: LLMProvider;
  readonly conversation: Conversation;
  readonly model: string;
  /** Tools the model may use. Without it, the agent is a plain chat. */
  readonly tools?: ToolRunner;
  readonly temperature?: number;
  /** Safety net against a model that keeps calling tools forever. */
  readonly maxSteps?: number;
  /** Keeps requests inside the context window (fit, compaction, calibration). */
  readonly context?: ContextManager;
  /** Injectable clock, so tests get deterministic durations. */
  readonly now?: () => number;
}

export const DEFAULT_MAX_STEPS = 25;

/** What one call to the model produced. */
interface StepResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage | undefined;
  readonly finishReason: string | undefined;
}

/**
 * Runs conversation turns: THE AGENT LOOP.
 *
 *   user message
 *     └─► call model ──► plain answer? ──yes──► done
 *            ▲               │ no: it asked for tools
 *            │               ▼
 *            └──── run tools, append results
 *
 * `runTurn` is an async generator: it *yields* events as they happen, and the
 * caller (UI, test) decides what to do with them. No callbacks, no event bus.
 */
export class Agent {
  readonly #provider: LLMProvider;
  readonly #conversation: Conversation;
  readonly #tools: ToolRunner | undefined;
  readonly #temperature: number | undefined;
  readonly #maxSteps: number;
  readonly #now: () => number;
  readonly #context: ContextManager | undefined;
  #model: string;
  /** Things the model should know before the next message (e.g. "the user undid your edit"). */
  #notes: string[] = [];

  constructor(options: AgentOptions) {
    this.#provider = options.provider;
    this.#conversation = options.conversation;
    this.#model = options.model;
    this.#tools = options.tools;
    this.#temperature = options.temperature;
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#now = options.now ?? Date.now;
    this.#context = options.context;
  }

  /** How full the context is right now (undefined without a ContextManager). */
  contextUsage(): ContextUsage | undefined {
    if (!this.#context) return undefined;
    // Measure what would really be SENT (after fitting), not the full stored history:
    // otherwise the UI shows scary numbers like "174%" for a request that fits fine.
    const fit = this.#context.fit(this.#conversation.messages(), this.#toolTokens());
    return {
      usedTokens: fit.estimatedTokens,
      limitTokens: this.#context.limit,
      ratio: fit.estimatedTokens / this.#context.limit,
    };
  }

  /** /context: where the tokens go. */
  contextReport():
    | {
        system: number;
        tools: number;
        conversation: number;
        messages: number;
        limit: number;
        window: number;
      }
    | undefined {
    if (!this.#context) return undefined;
    const messages = this.#conversation.messages();
    const est = this.#context.estimator;
    const system = est.messages(messages.filter((m) => m.role === 'system'));
    return {
      system,
      tools: this.#toolTokens(),
      conversation: est.messages(messages) - system,
      messages: messages.filter((m) => m.role !== 'system').length,
      limit: this.#context.limit,
      window: this.#context.contextWindow,
    };
  }

  /** /compact: summarise everything except the last turn, now. */
  async compactNow(signal: AbortSignal): Promise<CompactionResult | undefined> {
    return this.#context?.compact(this.#conversation, signal, 1);
  }

  /** The tool schemas are sent with every request, so they count against the budget. */
  #toolTokens(): number {
    const defs = this.#tools?.definitions() ?? [];
    return defs.length && this.#context ? this.#context.estimator.text(JSON.stringify(defs)) : 0;
  }

  get model(): string {
    return this.#model;
  }

  get providerName(): string {
    return this.#provider.name;
  }

  setModel(model: string): void {
    this.#model = model;
  }

  /** Start a fresh conversation (keeps the system prompt). */
  reset(): void {
    this.#conversation.clear();
    this.#notes = [];
  }

  /**
   * Queue a note for the model, delivered with the next user message.
   * Without it, the model would assume e.g. an undone edit is still in place.
   */
  addNote(note: string): void {
    this.#notes.push(note);
  }

  async *runTurn(input: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const startedAt = this.#now();
    let turnStart = this.#conversation.length; // to roll back the whole turn on error
    const notes = this.#notes.map((n) => `[Note from heph: ${n}]`);
    this.#notes = [];
    this.#conversation.addUser(notes.length ? [...notes, '', input].join('\n') : input);

    let compactedThisTurn = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;

    for (let step = 1; step <= this.#maxSteps; step++) {
      // ── 0. Context getting full? Summarise older turns first ──────────────
      // At most ONE compaction per turn: a second one mid-turn can only summarise
      // the little that is left and costs another full model call.
      if (
        !compactedThisTurn &&
        this.#context?.shouldCompact(this.#conversation.messages(), this.#toolTokens())
      ) {
        compactedThisTurn = true;
        yield { type: 'compacting' };
        try {
          const result = await this.#context.compact(this.#conversation, signal);
          if (result) yield { type: 'compacted', ...result };
          // indexes moved: the current turn now starts at the last user message
          turnStart = this.#conversation
            .messages()
            .map((m) => m.role)
            .lastIndexOf('user');
        } catch (error) {
          if (signal.aborted) {
            yield { type: 'interrupted' };
            return;
          }
          yield {
            type: 'warning',
            message: `Could not compact the conversation: ${(error as Error).message}`,
          };
        }
      }

      yield { type: 'thinking', step };

      // ── 1. Call the model and stream its answer ────────────────────────────
      let result: StepResult;
      try {
        result = yield* this.#callModel(signal);
      } catch (error) {
        if (signal.aborted) {
          yield* this.#interrupted(this.#partialText);
          return;
        }
        // The turn failed: remove it entirely so the history stays valid and the
        // user can simply retry.
        this.#conversation.truncate(turnStart);
        yield { type: 'error', error };
        return;
      }

      if (result.usage) {
        sawUsage = true;
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
      }

      if (signal.aborted) {
        yield* this.#interrupted(result.text);
        return;
      }

      this.#conversation.addAssistant(result.text, result.toolCalls);

      // ── 2. No tool calls → the model has answered. Turn over. ──────────────
      if (result.toolCalls.length === 0 || !this.#tools) {
        const context = this.contextUsage();
        yield {
          type: 'turn_end',
          durationMs: this.#now() - startedAt,
          steps: step,
          ...(sawUsage && { usage: { inputTokens, outputTokens } }),
          ...(result.finishReason && { finishReason: result.finishReason }),
          ...(context && {
            context: { usedTokens: context.usedTokens, limitTokens: context.limitTokens },
          }),
        };
        return;
      }

      // ── 3. Run each requested tool and append its result ───────────────────
      // Sequentially, not in parallel: simpler, and safer once tools can write (M3).
      for (const call of result.toolCalls) {
        if (signal.aborted) {
          // Every tool call MUST get a result, or the next request is invalid.
          this.#conversation.addToolResult(call.id, 'Cancelled: the user interrupted.');
          continue;
        }
        yield {
          type: 'tool_start',
          callId: call.id,
          name: call.name,
          label: this.#tools.describe(call),
        };
        const outcome = await this.#tools.run(call, signal);
        this.#conversation.addToolResult(call.id, outcome.output);
        yield {
          type: 'tool_end',
          callId: call.id,
          name: call.name,
          ok: outcome.ok,
          ...(outcome.denied && { denied: true }),
          durationMs: outcome.durationMs,
          ...(outcome.summary !== undefined && { summary: outcome.summary }),
        };
      }

      if (signal.aborted) {
        yield { type: 'interrupted' };
        return;
      }
      // …and loop: the model now sees the tool results and continues.
    }

    yield {
      type: 'warning',
      message: `Stopped after ${this.#maxSteps} steps without a final answer. Ask again to continue.`,
    };
    yield {
      type: 'turn_end',
      durationMs: this.#now() - startedAt,
      steps: this.#maxSteps,
      ...(sawUsage && { usage: { inputTokens, outputTokens } }),
    };
  }

  /** Text streamed so far in the current step (kept if the user interrupts). */
  #partialText = '';

  async *#callModel(signal: AbortSignal): AsyncGenerator<AgentEvent, StepResult> {
    const tools = this.#tools?.definitions() ?? [];
    // Never send more than fits: shorten / leave out old parts if necessary (non-destructive).
    const fit = this.#context?.fit(this.#conversation.messages(), this.#toolTokens());
    if (fit?.actions.length) yield { type: 'context_trimmed', actions: fit.actions };
    const request: ChatRequest = {
      model: this.#model,
      messages: fit?.messages ?? this.#conversation.messages(),
      ...(tools.length > 0 && { tools }),
      ...(this.#temperature !== undefined && { temperature: this.#temperature }),
    };

    let text = '';
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    this.#partialText = '';

    for await (const chunk of this.#provider.chat(request, signal)) {
      if (signal.aborted) break;
      switch (chunk.type) {
        case 'text':
          text += chunk.delta;
          this.#partialText = text;
          yield { type: 'text', delta: chunk.delta };
          break;
        case 'reasoning':
          yield { type: 'reasoning', delta: chunk.delta };
          break;
        case 'tool_call':
          toolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments });
          break;
        case 'done':
          usage = chunk.usage;
          finishReason = chunk.finishReason;
          break;
      }
    }
    // Learn the real token count, so the estimates match this model.
    if (fit && usage) this.#context?.estimator.calibrate(fit.estimatedTokens, usage.inputTokens);
    return { text, toolCalls, usage, finishReason };
  }

  /** Leave the history valid after Ctrl+C, keeping what the model already said. */
  *#interrupted(partialText: string): Generator<AgentEvent> {
    if (partialText) this.#conversation.addAssistant(`${partialText}\n\n[interrupted by the user]`);
    else if (this.#conversation.messages().at(-1)?.role === 'user') this.#conversation.removeLast();
    yield { type: 'interrupted' };
  }
}
