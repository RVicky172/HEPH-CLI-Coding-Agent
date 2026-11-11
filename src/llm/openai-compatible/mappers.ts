import type OpenAI from 'openai';
import type { ToolDefinition } from '../../core/agent/ToolRunner.js';
import type { Message } from '../../core/conversation/Message.js';
import type { TokenUsage } from '../LLMProvider.js';

type OpenAIMessage = OpenAI.Chat.ChatCompletionMessageParam;
type OpenAITool = OpenAI.Chat.ChatCompletionTool;

/** Our neutral messages → OpenAI wire format. */
export function toOpenAIMessages(messages: readonly Message[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        if (m.toolCalls?.length) {
          return {
            role: 'assistant',
            // OpenAI wants null (not "") when the model only called tools.
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          };
        }
        return { role: 'assistant', content: m.content };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

export function toOpenAITools(tools: readonly ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toTokenUsage(
  usage: OpenAI.CompletionUsage | null | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

/**
 * Reasoning models stream their "thinking" in a non-standard field.
 * LM Studio and several servers use `reasoning_content`, others use `reasoning`.
 */
export function extractReasoning(delta: unknown): string | undefined {
  if (typeof delta !== 'object' || delta === null) return undefined;
  const d = delta as { reasoning_content?: unknown; reasoning?: unknown };
  const value = d.reasoning_content ?? d.reasoning;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

type ToolCallDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta.ToolCall;

/**
 * While streaming, a tool call arrives in FRAGMENTS, keyed by `index`:
 *   {index:0, id:"call_1", function:{name:"read_file", arguments:""}}
 *   {index:0, function:{arguments:"{\"pa"}}
 *   {index:0, function:{arguments:"th\":\"a.ts\"}"}}
 * This class glues them back together.
 */
export class ToolCallAssembler {
  readonly #calls = new Map<number, { id: string; name: string; arguments: string }>();

  add(deltas: readonly ToolCallDelta[] | undefined): void {
    for (const d of deltas ?? []) {
      const call = this.#calls.get(d.index) ?? { id: '', name: '', arguments: '' };
      if (d.id) call.id = d.id;
      if (d.function?.name) call.name += d.function.name;
      if (d.function?.arguments) call.arguments += d.function.arguments;
      this.#calls.set(d.index, call);
    }
  }

  /** Complete calls in order. Some local servers omit ids, so we generate them. */
  finish(): { id: string; name: string; arguments: string }[] {
    return [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([index, c]) => ({ ...c, id: c.id || `call_${index}_${Date.now().toString(36)}` }));
  }
}
