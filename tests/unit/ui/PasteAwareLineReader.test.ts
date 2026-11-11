import { describe, expect, it } from 'vitest';
import { PasteAwareLineReader } from '../../../src/ui/input/PasteAwareLineReader.js';

/**
 * A controllable line source: tests decide exactly when each line "arrives",
 * simulating a paste (many lines at once) versus typing (one line, then a pause).
 */
class LineSource implements AsyncIterator<string> {
  #queue: string[] = [];
  #waiting: ((r: IteratorResult<string>) => void) | undefined;
  #closed = false;

  push(...lines: string[]) {
    for (const line of lines) {
      if (this.#waiting) {
        const resolve = this.#waiting;
        this.#waiting = undefined;
        resolve({ value: line, done: false });
      } else this.#queue.push(line);
    }
  }
  close() {
    this.#closed = true;
    this.#waiting?.({ value: undefined, done: true });
  }
  next(): Promise<IteratorResult<string>> {
    const line = this.#queue.shift();
    if (line !== undefined) return Promise.resolve({ value: line, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => (this.#waiting = resolve));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PasteAwareLineReader', () => {
  it('combines a multi-line paste into ONE message (the "endless loop" bug)', async () => {
    const source = new LineSource();
    const reader = new PasteAwareLineReader(source, { windowMs: 20 });
    source.push('Explain this file:', '# heph', '', 'A small coding agent.');

    expect(await reader.read()).toEqual({
      text: 'Explain this file:\n# heph\n\nA small coding agent.',
      lineCount: 4,
    });
  });

  it('keeps separately typed lines as separate messages', async () => {
    const source = new LineSource();
    const reader = new PasteAwareLineReader(source, { windowMs: 20 });

    source.push('first');
    expect(await reader.read()).toEqual({ text: 'first', lineCount: 1 });

    setTimeout(() => source.push('second'), 50); // typed later, after the window
    expect(await reader.read()).toEqual({ text: 'second', lineCount: 1 });
  });

  it('does not lose a line that arrives after the window closed', async () => {
    let releaseTimer!: () => void;
    const source = new LineSource();
    // A manual timer: the window "closes" exactly when we say so.
    const reader = new PasteAwareLineReader(source, {
      wait: () => new Promise<void>((r) => (releaseTimer = r)),
    });

    source.push('one');
    const first = reader.read();
    await tick();
    releaseTimer(); // window closes with no further line
    expect(await first).toEqual({ text: 'one', lineCount: 1 });

    source.push('two'); // must be picked up by the pending next() from the race
    const second = reader.read();
    await tick();
    releaseTimer();
    expect(await second).toEqual({ text: 'two', lineCount: 1 });
  });

  it('returns the last message, then null, when input ends', async () => {
    const source = new LineSource();
    const reader = new PasteAwareLineReader(source, { windowMs: 20 });
    source.push('bye');
    source.close();
    expect(await reader.read()).toEqual({ text: 'bye', lineCount: 1 });
    expect(await reader.read()).toBeNull();
  });
});
