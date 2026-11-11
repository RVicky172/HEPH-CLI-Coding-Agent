import fs from 'node:fs/promises';

interface Checkpoint {
  readonly relative: string;
  readonly absolute: string;
  /** The file's bytes before the change, or undefined if the change CREATED it. */
  readonly previous: Buffer | undefined;
  readonly toolName: string;
}

export interface UndoResult {
  readonly relative: string;
  readonly action: 'restored' | 'deleted';
  readonly toolName: string;
}

/**
 * The safety net behind `/undo`: before every write, the original content is
 * saved. Undo restores it, or deletes the file if heph created it.
 *
 * Kept in memory (this session only) on purpose: it's simple and never writes
 * clutter into your project. A later improvement could persist checkpoints in
 * .heph/checkpoints so undo survives a restart.
 */
export class CheckpointStore {
  readonly #stack: Checkpoint[] = [];

  record(checkpoint: Checkpoint): void {
    this.#stack.push(checkpoint);
  }

  get size(): number {
    return this.#stack.length;
  }

  async undoLast(): Promise<UndoResult | undefined> {
    const last = this.#stack.pop();
    if (!last) return undefined;
    if (last.previous === undefined) {
      await fs.rm(last.absolute, { force: true });
      return { relative: last.relative, action: 'deleted', toolName: last.toolName };
    }
    await fs.writeFile(last.absolute, last.previous);
    return { relative: last.relative, action: 'restored', toolName: last.toolName };
  }
}
