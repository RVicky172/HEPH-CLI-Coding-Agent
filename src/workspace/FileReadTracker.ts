export type Freshness = 'fresh' | 'never_read' | 'changed';

/**
 * Remembers which files the model has READ, and their modification time at that moment.
 *
 * Two rules for edits come from this:
 *  1. No blind edits: the model must read a file before changing it.
 *  2. No stale edits: if the file changed since then (the user edited it in
 *     their editor), the model must read it again. Otherwise it would
 *     overwrite the user's work with an outdated version.
 */
export class FileReadTracker {
  readonly #reads = new Map<string, number>();

  record(relativePath: string, mtimeMs: number): void {
    this.#reads.set(relativePath, mtimeMs);
  }

  check(relativePath: string, currentMtimeMs: number): Freshness {
    const seen = this.#reads.get(relativePath);
    if (seen === undefined) return 'never_read';
    return seen === currentMtimeMs ? 'fresh' : 'changed';
  }
}
