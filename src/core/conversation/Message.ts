/**
 * Provider-neutral chat messages.
 *
 * The core speaks only this format. Each LLM provider translates it to its own
 * wire format (see llm/openai-compatible/mappers.ts). That's what lets us swap
 * OpenAI ⇄ LM Studio ⇄ a test fake without touching the core.
 */
export interface SystemMessage {
  readonly role: 'system';
  readonly content: string;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: string;
}

/** The model asking us to run a tool. */
export interface ToolCall {
  /** Unique id. The matching tool result must carry the same id. */
  readonly id: string;
  readonly name: string;
  /** Raw JSON text produced by the model. It may be invalid, so we validate before use. */
  readonly arguments: string;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  /** Present when the model wants tools run before it can answer. */
  readonly toolCalls?: readonly ToolCall[];
}

/** The result of running one tool call, sent back to the model. */
export interface ToolResultMessage {
  readonly role: 'tool';
  readonly toolCallId: string;
  readonly content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export type Role = Message['role'];
