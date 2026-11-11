import type { Message } from '../conversation/Message.js';

/**
 * Counting tokens EXACTLY needs the model's own tokenizer, and every model has
 * a different one (Qwen ≠ Llama ≠ GPT). Instead we ESTIMATE: about 3.6
 * characters per token for English and code. Then we CALIBRATE against the real
 * count the server reports after each request (`usage.prompt_tokens`), so the
 * estimate quickly adapts to the model in use.
 */
const CHARS_PER_TOKEN = 3.6;
/** Every message costs a few tokens of formatting (role markers, separators). */
const PER_MESSAGE_OVERHEAD = 4;

export class TokenEstimator {
  /** Multiplier learned from real usage (1 = the plain heuristic). */
  #ratio = 1;

  get ratio(): number {
    return this.#ratio;
  }

  text(text: string): number {
    return Math.ceil((text.length / CHARS_PER_TOKEN) * this.#ratio);
  }

  message(message: Message): number {
    let chars = message.content.length;
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? [])
        chars += call.name.length + call.arguments.length + 12;
    }
    return Math.ceil((chars / CHARS_PER_TOKEN) * this.#ratio) + PER_MESSAGE_OVERHEAD;
  }

  messages(messages: readonly Message[]): number {
    return messages.reduce((sum, m) => sum + this.message(m), 0);
  }

  /**
   * Learn from the server: "you estimated X, it was really Y". An exponential
   * moving average smooths noise. The clamp protects against one weird response.
   */
  calibrate(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    const observed = (actual / estimated) * this.#ratio;
    this.#ratio = clamp(this.#ratio * 0.5 + observed * 0.5, 0.5, 3);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
