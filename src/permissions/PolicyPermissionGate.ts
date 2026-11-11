import { grantScope, type ApprovalRequest } from './ApprovalRequest.js';
import type { Approver } from './Approver.js';
import type { PermissionDecision, PermissionGate } from './PermissionGate.js';
import { DEFAULT_MODE, type PermissionMode, type ReadPolicy } from './PermissionMode.js';
import { PermissionRules } from './PermissionRules.js';

/**
 * The real permission gate. Decision order, first match wins:
 *
 *   1. read tool: reads="auto", auto-edit/full-auto mode, or "always" given → ALLOW
 *                 otherwise → ASK (once you answer "a", all reads are allowed for the session)
 *   2. mode is read-only                      → DENY
 *   3. a config DENY rule matches             → DENY   (even in full-auto)
 *   4. command looks DANGEROUS                → ASK    (even in full-auto / with allow rules)
 *   5. a config ALLOW rule matches            → ALLOW  (preview still shown)
 *   6. user said "always" for this earlier    → ALLOW  (preview still shown)
 *   7. the mode auto-approves this risk level → ALLOW  (preview still shown)
 *   8. otherwise                              → ASK the human (Approver)
 */
export class PolicyPermissionGate implements PermissionGate {
  readonly #approver: Approver;
  readonly #rules: PermissionRules;
  readonly #sessionGrants = new Map<string, string>(); // key → label
  #mode: PermissionMode;
  #reads: ReadPolicy;

  /**
   * `reads` defaults to 'auto' here so the class is easy to use in tests; the
   * product default ('ask') comes from the config (see ConfigLoader).
   */
  constructor(
    approver: Approver,
    mode: PermissionMode = DEFAULT_MODE,
    rules: PermissionRules = new PermissionRules(),
    reads: ReadPolicy = 'auto',
  ) {
    this.#approver = approver;
    this.#mode = mode;
    this.#rules = rules;
    this.#reads = reads;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  get reads(): ReadPolicy {
    return this.#reads;
  }

  setReads(reads: ReadPolicy): void {
    this.#reads = reads;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  /** What the user approved with "always" in this session (labels, for display). */
  get sessionGrants(): string[] {
    return [...this.#sessionGrants.values()];
  }

  clearSessionGrants(): void {
    this.#sessionGrants.clear();
  }

  async check(request: ApprovalRequest, signal: AbortSignal): Promise<PermissionDecision> {
    if (request.risk === 'read') return this.#checkRead(request, signal);

    if (this.#mode === 'read-only') {
      return {
        verdict: 'deny',
        summary: 'blocked: read-only mode',
        message:
          `NOT APPLIED: ${request.toolName} is not allowed because heph is in read-only mode, so nothing happened. ` +
          'Do not try again. Tell the user they can allow it with `/mode ask`.',
      };
    }

    if (this.#rules.isDenied(request)) {
      return {
        verdict: 'deny',
        summary: 'blocked by a deny rule',
        message:
          `NOT APPLIED: ${request.toolName} was blocked by a "deny" rule in the user's heph config, ` +
          'so nothing happened. Do not try to work around it. Tell the user.',
      };
    }

    const dangerous = request.preview.kind === 'command' && request.preview.warnings.length > 0;
    if (!dangerous) {
      if (this.#rules.isAllowed(request)) {
        this.#approver.show(request, 'auto-approved: matches an "allow" rule in your config');
        return { verdict: 'allow' };
      }
      const scope = grantScope(request);
      if (this.#sessionGrants.has(scope.key)) {
        this.#approver.show(request, `auto-approved: you chose "always" for ${scope.label}`);
        return { verdict: 'allow' };
      }
      if (this.#autoApproves(request)) {
        this.#approver.show(request, `auto-approved: mode ${this.#mode}`);
        return { verdict: 'allow' };
      }
    }

    const answer = await this.#approver.ask(request, signal);
    switch (answer.decision) {
      case 'allow':
        return { verdict: 'allow' };
      case 'allow_session': {
        // Never remember "always" for a dangerous command: ask every single time.
        if (!dangerous) {
          const scope = grantScope(request);
          this.#sessionGrants.set(scope.key, scope.label);
        }
        return { verdict: 'allow' };
      }
      case 'deny':
        return deniedByUser(request.toolName, answer.feedback, answer.reason);
    }
  }

  /** Reads never show a preview when allowed: they change nothing, and showing each one would be noise. */
  async #checkRead(request: ApprovalRequest, signal: AbortSignal): Promise<PermissionDecision> {
    if (this.#rules.isDenied(request)) {
      return {
        verdict: 'deny',
        summary: 'blocked by a deny rule',
        message: `NOT APPLIED: reading was blocked by a "deny" rule in the user's heph config. Tell the user.`,
      };
    }
    const auto = this.#reads === 'auto' || this.#mode === 'auto-edit' || this.#mode === 'full-auto';
    const scope = grantScope(request);
    if (auto || this.#sessionGrants.has(scope.key) || this.#rules.isAllowed(request)) {
      return { verdict: 'allow' };
    }
    const answer = await this.#approver.ask(request, signal);
    switch (answer.decision) {
      case 'allow':
        return { verdict: 'allow' };
      case 'allow_session':
        this.#sessionGrants.set(scope.key, scope.label);
        return { verdict: 'allow' };
      case 'deny':
        return deniedByUser(request.toolName, answer.feedback, answer.reason);
    }
  }

  #autoApproves(request: ApprovalRequest): boolean {
    if (this.#mode === 'full-auto') return true;
    if (this.#mode === 'auto-edit') return request.risk === 'write';
    return false;
  }
}

function deniedByUser(
  toolName: string,
  feedback: string | undefined,
  reason: 'non_interactive' | undefined,
): PermissionDecision {
  if (reason === 'non_interactive') {
    return {
      verdict: 'deny',
      summary: 'not applied: no terminal to ask',
      message:
        `NOT APPLIED: ${toolName} did not run, so nothing changed. heph is not running in an ` +
        'interactive terminal, so nobody could approve it. Tell the user it was NOT done ' +
        'and show what they can run or apply themselves. Do not claim it was done.',
    };
  }
  if (feedback?.trim()) {
    return {
      verdict: 'deny',
      summary: 'denied with feedback',
      message: `NOT APPLIED: the user rejected this ${toolName} call, so nothing happened. They said: "${feedback.trim()}". Follow their instruction instead.`,
    };
  }
  return {
    verdict: 'deny',
    summary: 'denied by you',
    message:
      `NOT APPLIED: the user rejected this ${toolName} call, so nothing happened. Do not retry the same action. ` +
      'Ask the user how they would like to proceed.',
  };
}
