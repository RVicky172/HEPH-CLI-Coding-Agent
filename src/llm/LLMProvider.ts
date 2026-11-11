import type { ToolDefinition } from '../core/agent/ToolRunner.js';
import type { Message } from '../core/conversation/Message.js';

/**
 * The port between the core and any LLM backend (Dependency Inversion).
 *
 * The Agent depends on THIS interface, never on the `openai` package.
 * Implementations: OpenAICompatibleProvider (OpenAI, LM Studio, Ollama, vLLM)
 * and ScriptedProvider (deterministic fake for tests).
 */
export interface LLMProvider {
  /** Human-readable name, e.g. the profile name. */
  readonly name: string;

  /** Streams one model response. Throws LLMError on failure. Honours `signal` for Ctrl+C. */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;

  /** Model ids the server offers. */
  listModels(signal?: AbortSignal): Promise<string[]>;

  /** The model's context window in tokens, if the server can tell (optional). */
  contextWindow?(model: string): Promise<number | undefined>;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  /** Tools the model may call. Omitted or empty = plain chat. */
  readonly tools?: readonly ToolDefinition[];
  readonly temperature?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ChatChunk =
  /** A piece of the visible answer. */
  | { readonly type: 'text'; readonly delta: string }
  /** A piece of the model's "thinking" (reasoning models only). Shown dimmed, not stored. */
  | { readonly type: 'reasoning'; readonly delta: string }
  /**
   * A COMPLETE tool call. Providers receive tool calls in fragments while
   * streaming and must assemble them before emitting this chunk.
   */
  | {
      readonly type: 'tool_call';
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  /** Always the last chunk. */
  | { readonly type: 'done'; readonly usage?: TokenUsage; readonly finishReason?: string };
