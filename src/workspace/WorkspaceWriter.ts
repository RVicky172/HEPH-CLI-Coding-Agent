import fs from 'node:fs/promises';
import path from 'node:path';
import type { CheckpointStore } from './CheckpointStore.js';
import type { FileReadTracker } from './FileReadTracker.js';
import type { Workspace } from './Workspace.js';
import { SensitivePathError, WorkspaceError } from './WorkspaceError.js';

export interface LoadedFile {
  readonly absolute: string;
  readonly relative: string;
  readonly exists: boolean;
  /** Current text (undefined for a new file). */
  readonly text: string | undefined;
}

/** heph's own internals and git's database must never be written by the model. */
const PROTECTED_DIRS = ['.git', '.heph'];

/**
 * WRITE access to the workspace. Given ONLY to write tools (Interface
 * Segregation): read tools receive the read-only Workspace and have no way
 * to change a file.
 *
 * Every write goes through the same checks:
 *   PathGuard (inside the workspace) → not a secret or protected folder →
 *   file was read and hasn't changed since → checkpoint for /undo → write
 *
 * NOTE: the *user's approval* happens before this, in the PermissionGate.
 * This class enforces the rules that hold even when the user says yes.
 */
export class WorkspaceWriter {
  readonly #workspace: Workspace;
  readonly #checkpoints: CheckpointStore;
  readonly #reads: FileReadTracker;

  constructor(workspace: Workspace, checkpoints: CheckpointStore, reads: FileReadTracker) {
    this.#workspace = workspace;
    this.#checkpoints = checkpoints;
    this.#reads = reads;
  }

  /** Loads a file for changing it, enforcing all rules except approval. */
  async load(requested: string): Promise<LoadedFile> {
    const { absolute, relative } = this.#workspace.resolve(requested);
    this.#assertWritable(relative);

    const info = await this.#workspace.stat(relative);
    if (!info) return { absolute, relative, exists: false, text: undefined };
    if (info.isDirectory) throw new WorkspaceError(`"${relative}" is a directory, not a file.`);

    switch (this.#reads.check(relative, info.mtimeMs)) {
      case 'never_read':
        throw new WorkspaceError(
          `You must read "${relative}" with read_file before changing it. Never edit a file you haven't seen.`,
        );
      case 'changed':
        throw new WorkspaceError(
          `"${relative}" changed since you last read it (the user may have edited it). ` +
            'Read it again before changing it.',
        );
      case 'fresh':
        break;
    }

    const buffer = await this.#workspace.readFile(relative);
    if (buffer.subarray(0, 8000).includes(0)) {
      throw new WorkspaceError(`"${relative}" is a binary file and can't be edited as text.`);
    }
    return { absolute, relative, exists: true, text: buffer.toString('utf8') };
  }

  /** Writes the file (creating folders as needed) after saving a checkpoint. */
  async write(requested: string, content: string, toolName: string): Promise<void> {
    const file = await this.load(requested); // re-check everything right before writing
    const previous = file.exists ? await fs.readFile(file.absolute) : undefined;

    this.#checkpoints.record({
      relative: file.relative,
      absolute: file.absolute,
      previous,
      toolName,
    });
    await fs.mkdir(path.dirname(file.absolute), { recursive: true });
    await fs.writeFile(file.absolute, content, 'utf8');

    // We just wrote it, so the model's knowledge of the file is up to date.
    const info = await this.#workspace.stat(file.relative);
    if (info) this.#reads.record(file.relative, info.mtimeMs);
  }

  #assertWritable(relative: string): void {
    if (relative === '.') throw new WorkspaceError('Cannot write to the workspace folder itself.');
    if (this.#workspace.rules.isSensitive(relative)) throw new SensitivePathError(relative);
    const top = relative.split('/')[0] ?? '';
    if (PROTECTED_DIRS.includes(top)) {
      throw new WorkspaceError(
        `Access denied: "${relative}" is inside ${top}/, which heph never modifies.`,
      );
    }
  }
}
