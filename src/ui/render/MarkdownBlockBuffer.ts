/**
 * Streaming + Markdown don't mix easily: "**bo" can't be rendered until "ld**"
 * arrives, and a code block can't be highlighted until it's closed.
 *
 * Solution: buffer the streamed text and release it in COMPLETE BLOCKS
 * (paragraphs, lists, closed code fences). Each block is rendered once, as soon
 * as it's finished, so the answer still appears progressively, block by block.
 *
 * A block ends at a blank line, but never inside a ``` fence.
 */
export class MarkdownBlockBuffer {
  #buffer = '';

  /** Adds streamed text and returns any blocks that are now complete. */
  push(delta: string): string[] {
    this.#buffer += delta;
    const blocks: string[] = [];
    for (;;) {
      const end = findBlockEnd(this.#buffer);
      if (end === -1) break;
      const block = this.#buffer.slice(0, end).replace(/\s+$/, '');
      this.#buffer = this.#buffer.slice(end).replace(/^\n+/, '');
      if (block.trim()) blocks.push(block);
    }
    return blocks;
  }

  /** Returns whatever is left (end of the answer), even if incomplete. */
  flush(): string | undefined {
    const rest = this.#buffer.replace(/\s+$/, '');
    this.#buffer = '';
    return rest.trim() ? rest : undefined;
  }
}

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Index where the first complete block ends (the start of the blank line that
 * closes it), or -1 if no block is complete yet. Only complete lines are
 * considered: the text after the last "\n" may still be growing.
 */
function findBlockEnd(text: string): number {
  let inFence = false;
  let sawContent = false;
  let pos = 0;
  for (;;) {
    const newline = text.indexOf('\n', pos);
    if (newline === -1) return -1; // last line is incomplete
    const line = text.slice(pos, newline);
    if (FENCE.test(line)) {
      inFence = !inFence;
      sawContent = true;
      if (!inFence) return newline + 1; // a closed code block is a complete block
    } else if (!inFence && line.trim() === '') {
      if (sawContent) return pos;
    } else {
      sawContent = true;
    }
    pos = newline + 1;
  }
}
