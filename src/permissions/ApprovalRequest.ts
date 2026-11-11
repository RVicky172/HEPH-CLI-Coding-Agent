/**
 * How dangerous a tool is. The permission gate decides per level:
 * read = automatic; write/execute = depends on the mode (default: ask the user).
 */
export type RiskLevel = 'read' | 'write' | 'execute';

/** One line of a diff, with line numbers for display. */
export interface DiffLine {
  readonly kind: 'add' | 'remove' | 'context';
  readonly text: string;
  /** Line number in the old file (remove/context). */
  readonly oldLine?: number;
  /** Line number in the new file (add/context). */
  readonly newLine?: number;
}

export interface DiffHunk {
  readonly lines: readonly DiffLine[];
}

/**
 * Exactly what a tool is about to do, shown to the user BEFORE it happens.
 * Library-neutral, so the UI doesn't depend on the diff package.
 */
export type ActionPreview =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'diff';
      readonly path: string;
      readonly isNewFile: boolean;
      readonly added: number;
      readonly removed: number;
      readonly hunks: readonly DiffHunk[];
    }
  | {
      readonly kind: 'command';
      readonly command: string;
      /** Workspace-relative working directory. */
      readonly cwd: string;
      /** What the model says the command is for. */
      readonly purpose?: string;
      /** From DangerousCommandDetector. Non-empty = always ask. */
      readonly warnings: readonly string[];
    };

/** What the permission gate is asked to decide on. */
export interface ApprovalRequest {
  readonly toolName: string;
  readonly risk: RiskLevel;
  /** Short label, e.g. the file path. */
  readonly label: string;
  readonly preview: ActionPreview;
}

/**
 * What "always allow" covers for a request:
 *  - file tools: the whole tool for this session ("always for edit_file")
 *  - run_command: only that EXACT command ("always for `npm test`"),
 *    because "always run any command" would be far too broad.
 */
export function grantScope(request: ApprovalRequest): { key: string; label: string } {
  // One "always" covers every read tool: answering for each file would be unbearable.
  if (request.risk === 'read') return { key: 'read:*', label: 'all reads this session' };
  if (request.preview.kind === 'command') {
    return {
      key: `${request.toolName}:${request.preview.command}`,
      label: `\`${request.preview.command}\``,
    };
  }
  return { key: request.toolName, label: request.toolName };
}

/** The text config rules are matched against, e.g. "run_command:npm test" or "write_file:package.json". */
export function ruleSubject(request: ApprovalRequest): string {
  const { preview } = request;
  if (preview.kind === 'command') return `${request.toolName}:${preview.command}`;
  if (preview.kind === 'diff') return `${request.toolName}:${preview.path}`;
  return `${request.toolName}:${request.label}`;
}
