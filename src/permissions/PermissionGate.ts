import type { ApprovalRequest } from './ApprovalRequest.js';

export type PermissionDecision =
  | { readonly verdict: 'allow' }
  | {
      readonly verdict: 'deny';
      /** Sent to the model as the tool result, so it knows what happened and what to do. */
      readonly message: string;
      /** Short text for the UI, e.g. "denied by you". */
      readonly summary: string;
    };

/** Decides whether a tool call may run. The ToolExecutor asks it before every non-read tool. */
export interface PermissionGate {
  check(request: ApprovalRequest, signal: AbortSignal): Promise<PermissionDecision>;
}

/**
 * SAFE DEFAULT: reads are allowed, everything else is refused. Used whenever no
 * real gate is configured, so forgetting to wire the gate can never mean
 * "allow everything".
 */
export const denyAllChangesGate: PermissionGate = {
  async check(request) {
    if (request.risk === 'read') return { verdict: 'allow' };
    return {
      verdict: 'deny',
      message: `${request.toolName} is not available: no permission system is configured.`,
      summary: 'blocked',
    };
  },
};
