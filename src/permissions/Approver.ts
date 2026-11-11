import type { ApprovalRequest } from './ApprovalRequest.js';

export type ApprovalAnswer =
  | { readonly decision: 'allow' }
  /** "Yes, and don't ask again for this tool in this session." */
  | { readonly decision: 'allow_session' }
  | {
      readonly decision: 'deny';
      /** "No, do this instead…": passed to the model so it can adapt. */
      readonly feedback?: string;
      /** Set when nobody could be asked (no interactive terminal). */
      readonly reason?: 'non_interactive';
    };

/**
 * Asks a HUMAN. Implemented by the terminal UI. Tests use a FakeApprover
 * with scripted answers. The permission gate decides WHEN to ask.
 */
export interface Approver {
  /** Show the preview and wait for the user's answer. Must resolve to "deny" on Ctrl+C. */
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
  /** Show the preview without asking (auto-approved), so nothing changes silently. */
  show(request: ApprovalRequest, note: string): void;
}
