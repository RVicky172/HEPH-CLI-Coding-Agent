import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai';
import { LLMError } from '../../core/errors/LLMError.js';
import type { ChatChunk, ChatRequest, LLMProvider, TokenUsage } from '../LLMProvider.js';
import {
  extractReasoning,
  ToolCallAssembler,
  toOpenAIMessages,
  toOpenAITools,
  toTokenUsage,
} from './mappers.js';
import { ThinkTagSplitter } from './ThinkTagSplitter.js';

export interface OpenAICompatibleConfig {
  /** Profile name, used in messages. */
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/**
 * One class for every server that speaks the OpenAI Chat Completions API:
 * OpenAI itself, LM Studio, Ollama, vLLM, llama.cpp server…
 * Only baseURL / apiKey / model differ, and those come from config.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly #client: OpenAI;
  readonly #baseURL: string;

  constructor(config: OpenAICompatibleConfig, client?: OpenAI) {
    this.name = config.name;
    this.#baseURL = config.baseURL;
    this.#client =
      client ??
      new OpenAI({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        timeout: config.timeoutMs ?? 120_000,
        maxRetries: config.maxRetries ?? 1,
      });
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    const toolCalls = new ToolCallAssembler();
    const thinkTags = new ThinkTagSplitter();

    try {
      const stream = await this.#client.chat.completions.create(
        {
          model: request.model,
          messages: toOpenAIMessages(request.messages),
          stream: true,
          // Ask for a final chunk with token counts (OpenAI and LM Studio support it).
          stream_options: { include_usage: true },
          ...(request.tools?.length && { tools: toOpenAITools(request.tools) }),
          ...(request.temperature !== undefined && { temperature: request.temperature }),
        },
        signal ? { signal } : undefined,
      );

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const reasoning = extractReasoning(choice?.delta);
        if (reasoning) yield { type: 'reasoning', delta: reasoning };

        const content = choice?.delta?.content;
        if (content) {
          // <think>…</think> inside the content is reasoning, not answer.
          const split = thinkTags.push(content);
          if (split.reasoning) yield { type: 'reasoning', delta: split.reasoning };
          if (split.text) yield { type: 'text', delta: split.text };
        }

        toolCalls.add(choice?.delta?.tool_calls);

        if (choice?.finish_reason) finishReason = choice.finish_reason;
        usage = toTokenUsage(chunk.usage) ?? usage;
      }
    } catch (error) {
      throw this.#toLLMError(error, request.model);
    }

    // Tool calls are only complete once the stream has ended.
    const rest = thinkTags.flush();
    if (rest.reasoning) yield { type: 'reasoning', delta: rest.reasoning };
    if (rest.text) yield { type: 'text', delta: rest.text };
    for (const call of toolCalls.finish()) yield { type: 'tool_call', ...call };
    yield { type: 'done', ...(usage && { usage }), ...(finishReason && { finishReason }) };
  }

  /**
   * The OpenAI API doesn't report context sizes, but LM Studio has its own REST
   * API that does: GET /api/v0/models → loaded_context_length (what is actually
   * loaded) and max_context_length. Other servers: undefined (use config/default).
   */
  async contextWindow(model: string): Promise<number | undefined> {
    if (!this.#isLocal()) return undefined;
    try {
      const origin = new URL(this.#baseURL).origin;
      const response = await fetch(`${origin}/api/v0/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        data?: { id?: string; loaded_context_length?: number; max_context_length?: number }[];
      };
      const info = body.data?.find((m) => m.id === model);
      return info?.loaded_context_length ?? info?.max_context_length;
    } catch {
      return undefined;
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const page = await this.#client.models.list(signal ? { signal } : undefined);
      return page.data.map((m) => m.id);
    } catch (error) {
      throw this.#toLLMError(error);
    }
  }

  /** Translate SDK-specific errors into our neutral LLMError with a helpful hint. */
  #toLLMError(error: unknown, model?: string): unknown {
    if (error instanceof APIUserAbortError) return error; // Ctrl+C: not a failure
    const where = `${this.name} (${this.#baseURL})`;

    // Order matters: the timeout error is a subclass of the connection error.
    if (error instanceof APIConnectionTimeoutError) {
      return new LLMError(
        'timeout',
        `Request to ${where} timed out.`,
        'Large local models can be slow. Try again or raise "timeoutMs" in the profile.',
        { cause: error },
      );
    }
    if (error instanceof APIConnectionError) {
      return new LLMError(
        'connection',
        `Could not connect to ${where}.`,
        this.#isLocal()
          ? 'Is LM Studio running? Open its Developer tab and start the server, or run: lms server start'
          : 'Check your internet connection and the profile baseURL.',
        { cause: error },
      );
    }
    if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      return new LLMError(
        'auth',
        `The API key was rejected by ${where}.`,
        'Check the key for this profile (e.g. the OPENAI_API_KEY environment variable).',
        { cause: error },
      );
    }
    if (error instanceof NotFoundError) {
      return new LLMError(
        'not_found',
        model ? `Model "${model}" was not found on ${where}.` : `Endpoint not found on ${where}.`,
        'Run `heph models` to see available models, then pass one with --model.',
        { cause: error },
      );
    }
    if (error instanceof RateLimitError) {
      return new LLMError(
        'rate_limit',
        `Rate limited by ${where}.`,
        'Wait a moment, or check your plan’s quota.',
        { cause: error },
      );
    }
    if (error instanceof BadRequestError) {
      return new LLMError(
        'bad_request',
        `${where} rejected the request: ${error.message}`,
        undefined,
        { cause: error },
      );
    }
    if (error instanceof APIError) {
      return new LLMError('unknown', `${where} returned an error: ${error.message}`, undefined, {
        cause: error,
      });
    }
    return error;
  }

  #isLocal(): boolean {
    try {
      const host = new URL(this.#baseURL).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch {
      return false;
    }
  }
}
