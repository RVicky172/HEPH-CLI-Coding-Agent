import type { ChatChunk, ChatRequest, LLMProvider } from '../LLMProvider.js';

/**
 * One scripted reply:
 * - a string: streamed word by word, followed by a `done` chunk
 * - an Error: thrown when that turn is requested
 * - a chunk list: yielded exactly as given (full control)
 */
export type ScriptedReply = string | Error | readonly ChatChunk[];

/**
 * A fake LLM that replays predefined replies. It makes Agent tests fast,
 * free, offline and 100% deterministic. Liskov Substitution in action:
 * anything that works with a real provider must work with this one.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  /** Every request the agent sent, so tests can assert on it. */
  readonly requests: ChatRequest[] = [];
  readonly #replies: ScriptedReply[];
  readonly #models: string[];

  constructor(replies: readonly ScriptedReply[], options: { models?: string[] } = {}) {
    this.#replies = [...replies];
    this.#models = options.models ?? ['scripted-model'];
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    // Snapshot the messages: the agent's conversation keeps changing afterwards.
    this.requests.push({ ...request, messages: [...request.messages] });

    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error('ScriptedProvider: no more scripted replies');
    if (reply instanceof Error) throw reply;

    const chunks: readonly ChatChunk[] =
      typeof reply === 'string'
        ? [
            ...splitIntoWords(reply).map((delta) => ({ type: 'text', delta }) as const),
            { type: 'done', finishReason: 'stop' },
          ]
        : reply;

    for (const chunk of chunks) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await Promise.resolve(); // behave asynchronously like a real stream
      yield chunk;
    }
  }

  async listModels(): Promise<string[]> {
    return [...this.#models];
  }
}

/** Test helper: a reply in which the model calls one or more tools. */
export function toolCallReply(
  ...calls: { name: string; args: Record<string, unknown>; id?: string }[]
): ChatChunk[] {
  return [
    ...calls.map((c, i): ChatChunk => ({
      type: 'tool_call',
      id: c.id ?? `call_${i + 1}`,
      name: c.name,
      arguments: JSON.stringify(c.args),
    })),
    { type: 'done', finishReason: 'tool_calls' },
  ];
}

function splitIntoWords(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}
