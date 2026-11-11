import type { Message, ToolCall } from './Message.js';

/**
 * The message history of one chat session. Single responsibility: keep the
 * list of messages valid and in order. It knows nothing about LLMs or terminals.
 */
export class Conversation {
  readonly #systemPrompt: string | undefined;
  #messages: Message[] = [];

  constructor(systemPrompt?: string) {
    this.#systemPrompt = systemPrompt;
    this.clear();
  }

  addUser(content: string): void {
    this.#messages.push({ role: 'user', content });
  }

  addAssistant(content: string, toolCalls: readonly ToolCall[] = []): void {
    this.#messages.push(
      toolCalls.length > 0
        ? { role: 'assistant', content, toolCalls: [...toolCalls] }
        : { role: 'assistant', content },
    );
  }

  addToolResult(toolCallId: string, content: string): void {
    this.#messages.push({ role: 'tool', toolCallId, content });
  }

  /** Removes the last message (used to roll back a turn that failed). */
  removeLast(): Message | undefined {
    const last = this.#messages.at(-1);
    if (!last || last.role === 'system') return undefined;
    return this.#messages.pop();
  }

  /**
   * Drops every message after position `length`. Use `const mark = conversation.length`
   * before a turn, then `truncate(mark)` to undo the whole turn, tool steps included.
   */
  truncate(length: number): void {
    const keep = Math.max(length, this.#systemPrompt ? 1 : 0);
    this.#messages = this.#messages.slice(0, keep);
  }

  /**
   * Replace the whole history (used by compaction). If the list has no system
   * message, the current system prompt is kept in front.
   */
  replaceHistory(messages: readonly Message[]): void {
    const hasSystem = messages[0]?.role === 'system';
    this.#messages = [
      ...(!hasSystem && this.#systemPrompt
        ? [{ role: 'system' as const, content: this.#systemPrompt }]
        : []),
      ...messages,
    ];
  }

  /** Everything except the system prompt (what a saved session stores). */
  history(): readonly Message[] {
    return this.#messages.filter((m) => m.role !== 'system');
  }

  /** Load a saved history behind the CURRENT system prompt (rebuilt fresh at startup). */
  restore(history: readonly Message[]): void {
    this.clear();
    this.#messages.push(...history.filter((m) => m.role !== 'system'));
  }

  /** Forget everything except the system prompt. */
  clear(): void {
    this.#messages = this.#systemPrompt ? [{ role: 'system', content: this.#systemPrompt }] : [];
  }

  /** A copy, so callers can't mutate our history by accident. */
  messages(): readonly Message[] {
    return [...this.#messages];
  }

  get length(): number {
    return this.#messages.length;
  }
}
