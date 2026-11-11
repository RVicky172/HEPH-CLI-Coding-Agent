/**
 * Turns a stream of lines into user *messages*, treating a multi-line paste as ONE message.
 *
 * The bug this fixes: readline emits one "line" per newline. Pasting a 50-line
 * file therefore looked like 50 separate Enter presses, so heph sent 50 messages
 * and answered each one, which looks like an endless loop.
 *
 * The trick: pasted lines arrive (almost) at the same instant, while a human
 * can't press Enter twice within a few milliseconds. So after each line we wait
 * a short "paste window". Any line arriving within it belongs to the same message.
 */
export interface UserMessageInput {
  readonly text: string;
  /** How many lines were combined (more than 1 means it was a paste). */
  readonly lineCount: number;
}

const TIMED_OUT = Symbol('timed-out');

export class PasteAwareLineReader {
  readonly #lines: AsyncIterator<string>;
  readonly #windowMs: number;
  readonly #wait: (ms: number) => Promise<void>;
  /** A `next()` call that lost a race against the timer. It must be reused, or we'd drop a line. */
  #pending: Promise<IteratorResult<string>> | undefined;
  #ended = false;

  constructor(
    lines: AsyncIterator<string>,
    options: { windowMs?: number; wait?: (ms: number) => Promise<void> } = {},
  ) {
    this.#lines = lines;
    this.#windowMs = options.windowMs ?? 30;
    this.#wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Resolves with the next message, or `null` when input has ended. */
  async read(): Promise<UserMessageInput | null> {
    if (this.#ended) return null;

    const first = await this.#next();
    if (first.done) {
      this.#ended = true;
      return null;
    }

    const lines = [first.value];
    for (;;) {
      const more = await this.#nextWithin(this.#windowMs);
      if (more === TIMED_OUT) break;
      if (more.done) {
        this.#ended = true; // deliver what we have now, and report the end on the next read()
        break;
      }
      lines.push(more.value);
    }

    return { text: lines.join('\n'), lineCount: lines.length };
  }

  #next(): Promise<IteratorResult<string>> {
    const next = this.#pending ?? this.#lines.next();
    this.#pending = undefined;
    return next;
  }

  async #nextWithin(ms: number): Promise<IteratorResult<string> | typeof TIMED_OUT> {
    const next = this.#next();
    const result = await Promise.race([
      next,
      this.#wait(ms).then((): typeof TIMED_OUT => TIMED_OUT),
    ]);
    if (result === TIMED_OUT) this.#pending = next; // keep it for the next read()
    return result;
  }
}
