const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Some local reasoning models (Qwen3, DeepSeek-R1…) put their "thinking" inside
 * the normal answer text, wrapped in <think>…</think>, unless the server
 * separates it. This splits a STREAM of text into reasoning vs. answer.
 *
 * Streaming makes it tricky: a chunk may end in the middle of a tag ("<thi"),
 * so a possible partial tag at the end is held back until the next chunk.
 */
export class ThinkTagSplitter {
  #inThink = false;
  #pending = '';

  push(chunk: string): { text: string; reasoning: string } {
    let input = this.#pending + chunk;
    this.#pending = '';
    let text = '';
    let reasoning = '';

    while (input) {
      const tag = this.#inThink ? CLOSE : OPEN;
      const index = input.indexOf(tag);
      if (index !== -1) {
        if (this.#inThink) reasoning += input.slice(0, index);
        else text += input.slice(0, index);
        input = input.slice(index + tag.length);
        this.#inThink = !this.#inThink;
        continue;
      }
      // No complete tag: keep back a suffix that could be the start of one.
      const hold = partialTagSuffix(input, tag);
      const emit = input.slice(0, input.length - hold);
      if (this.#inThink) reasoning += emit;
      else text += emit;
      this.#pending = input.slice(input.length - hold);
      break;
    }
    return { text, reasoning };
  }

  /** End of stream: whatever was held back is ordinary output. */
  flush(): { text: string; reasoning: string } {
    const rest = this.#pending;
    this.#pending = '';
    return this.#inThink ? { text: '', reasoning: rest } : { text: rest, reasoning: '' };
  }
}

/** Length of the longest suffix of `text` that is a prefix of `tag` ("<th" for "<think>"). */
function partialTagSuffix(text: string, tag: string): number {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (tag.startsWith(text.slice(-len))) return len;
  }
  return 0;
}
