import type { z } from 'zod';
import type { ActionPreview, RiskLevel } from '../permissions/ApprovalRequest.js';
import type { Workspace } from '../workspace/Workspace.js';

export type { RiskLevel } from '../permissions/ApprovalRequest.js';

export interface ToolContext {
  /** Read-only, path-guarded access to the project. */
  readonly workspace: Workspace;
  /** Aborted when the user presses Ctrl+C. Long-running tools should check it. */
  readonly signal: AbortSignal;
  /** Live output for the UI while a long tool runs (e.g. a command's stdout). */
  readonly onProgress?: (text: string) => void;
}

export interface ToolResult {
  /** What the model receives. Keep it compact and structured: it costs tokens. */
  readonly output: string;
  /** What the human sees next to the tool line, e.g. "42 lines". */
  readonly summary?: string;
  /** false = the tool ran but the action failed (e.g. a command exited with code 1). Default true. */
  readonly ok?: boolean;
}

/**
 * One capability the model can use.
 *
 * The model only ever sees `name`, `description` and the JSON Schema made from
 * `schema`. Writing a clear description is half the work of building a tool.
 *
 * To add a tool: implement this interface and register it in container.ts.
 * Tools that need more than reading get their extra dependencies (like the
 * WorkspaceWriter) through their constructor, never through the shared context.
 */
export interface Tool<TArgs = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<TArgs>;
  readonly risk: RiskLevel;
  /** Short label for the UI, e.g. the path being read. */
  describe(args: TArgs): string;
  /**
   * For write/execute tools: describe EXACTLY what will happen (a diff, a command)
   * without doing it. The user approves this preview. Throw if the action is
   * impossible (e.g. text not found), so the user isn't asked about a doomed change.
   */
  preview?(args: TArgs, ctx: ToolContext): Promise<ActionPreview>;
  /** Throw on failure. The executor turns errors into a message for the model. */
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
