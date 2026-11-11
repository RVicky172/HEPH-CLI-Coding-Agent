import { structuredPatch } from 'diff';
import type { ActionPreview, DiffHunk, DiffLine } from '../../permissions/ApprovalRequest.js';

export type DiffPreview = Extract<ActionPreview, { kind: 'diff' }>;

/**
 * Builds a line diff between the current file and the proposed content,
 * in our own library-neutral format (see ApprovalRequest.ts).
 * Line endings are normalised so a CRLF file doesn't show every line as changed.
 */
export function createDiffPreview(
  path: string,
  before: string | undefined,
  after: string,
): DiffPreview {
  const oldText = toLf(before ?? '');
  const newText = toLf(after);
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: 3 });

  let added = 0;
  let removed = 0;
  const hunks: DiffHunk[] = patch.hunks.map((hunk) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines: DiffLine[] = [];
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === '+') {
        lines.push({ kind: 'add', text, newLine: newLine++ });
        added++;
      } else if (marker === '-') {
        lines.push({ kind: 'remove', text, oldLine: oldLine++ });
        removed++;
      } else if (marker === ' ') {
        lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
      }
      // '\' = "No newline at end of file" marker: not useful to show
    }
    return { lines };
  });

  return { kind: 'diff', path, isNewFile: before === undefined, added, removed, hunks };
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Keep the file's existing line-ending style when writing new content. */
export function matchLineEndings(original: string | undefined, content: string): string {
  const lf = toLf(content);
  return original?.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf;
}
