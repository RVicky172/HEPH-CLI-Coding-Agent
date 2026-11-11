import fs from 'node:fs';
import path from 'node:path';
import { PathOutsideWorkspaceError, WorkspaceError } from './WorkspaceError.js';

/**
 * LAYER 1 of file safety, always on, in every mode: every path a tool touches
 * must resolve to somewhere INSIDE the workspace root.
 *
 * It blocks:
 *  - relative escapes:   ../../secret.txt
 *  - absolute paths:     C:\Users\me\.ssh\id_rsa   /etc/passwd
 *  - symlink/junction escapes: a link inside the project pointing outside it
 */
export class PathGuard {
  readonly root: string;
  readonly #realRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.#realRoot = fs.realpathSync.native(this.root);
  }

  /** Returns the absolute path, or throws PathOutsideWorkspaceError. */
  resolve(requested: string): string {
    if (requested.includes('\0')) throw new WorkspaceError('Invalid path (contains a NUL byte).');

    const absolute = path.resolve(this.root, requested);

    // 1. Lexical check: catches "..", absolute paths and other drives.
    if (!isInside(this.root, absolute)) throw new PathOutsideWorkspaceError(requested, this.root);

    // 2. Physical check: follow symlinks/junctions of the part that exists.
    const real = realpathOfExistingAncestor(absolute);
    if (!isInside(this.#realRoot, real)) throw new PathOutsideWorkspaceError(requested, this.root);

    return absolute;
  }

  /** Workspace-relative path with forward slashes ("." for the root). Used for display and ignore rules. */
  relative(absolute: string): string {
    const rel = path.relative(this.root, absolute);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
  }
}

/**
 * Is `candidate` the root itself or below it?
 * path.relative is case-insensitive on Windows, which is what we want there.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath of the deepest part of `p` that exists (the file may not exist yet). */
function realpathOfExistingAncestor(p: string): string {
  let current = p;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
