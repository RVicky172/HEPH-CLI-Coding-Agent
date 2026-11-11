import { HephError } from '../core/errors/HephError.js';

/** A tool tried to do something the workspace rules forbid. The message goes back to the model. */
export class WorkspaceError extends HephError {}

export class PathOutsideWorkspaceError extends WorkspaceError {
  constructor(requested: string, root: string) {
    super(
      `Access denied: "${requested}" is outside the workspace (${root}). ` +
        'heph can only access files inside the folder it was started in.',
    );
  }
}

export class SensitivePathError extends WorkspaceError {
  constructor(relativePath: string) {
    super(
      `Access denied: "${relativePath}" may contain secrets (keys, passwords, tokens) and is blocked.`,
    );
  }
}
