import { z } from 'zod';
import type { ToolOutcome, ToolRunner } from '../core/agent/ToolRunner.js';
import type { ToolCall } from '../core/conversation/Message.js';
import { noAuditLog, type AuditLog } from '../logging/AuditLog.js';
import type { ActionPreview } from '../permissions/ApprovalRequest.js';
import { denyAllChangesGate, type PermissionGate } from '../permissions/PermissionGate.js';
import type { Workspace } from '../workspace/Workspace.js';
import type { ToolRegistry } from './ToolRegistry.js';

export interface ToolExecutorOptions {
  /** Max characters of tool output sent to the model (protects the context window). */
  readonly outputLimit?: number;
  /** Decides on every non-read tool call. Default: refuse all changes (safe). */
  readonly gate?: PermissionGate;
  /** Receives live tool output (call id + text chunk), e.g. to show it in the UI. */
  readonly onProgress?: (callId: string, text: string) => void;
  /** Records every call (and the permission decision). Default: no log. */
  readonly audit?: AuditLog;
  /** Session id written to the audit log. */
  readonly sessionId?: string;
  readonly now?: () => number;
}

export const DEFAULT_OUTPUT_LIMIT = 20_000;

/**
 * Runs one tool call through a fixed pipeline, one responsibility per step:
 *
 *   1. look up the tool      → unknown? tell the model which tools exist
 *   2. parse the JSON args   → invalid JSON? tell the model
 *   3. validate with zod     → wrong args? send the exact validation error back
 *   4. permission           → preview (diff) → PermissionGate → maybe ask the user
 *   5. execute               → thrown errors become "Error: …" results
 *   6. truncate the output   → never blow up the context window
 *
 * It NEVER throws. A failing tool must not crash the agent: the model reads
 * the error and tries something else. Small local models rely on this
 * feedback loop a lot.
 */
export class ToolExecutor implements ToolRunner {
  readonly #registry: ToolRegistry;
  readonly #workspace: Workspace;
  readonly #outputLimit: number;
  readonly #gate: PermissionGate;
  readonly #onProgress: ((callId: string, text: string) => void) | undefined;
  readonly #audit: AuditLog;
  readonly #sessionId: string;
  readonly #now: () => number;

  constructor(registry: ToolRegistry, workspace: Workspace, options: ToolExecutorOptions = {}) {
    this.#registry = registry;
    this.#workspace = workspace;
    this.#outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    this.#gate = options.gate ?? denyAllChangesGate;
    this.#onProgress = options.onProgress;
    this.#audit = options.audit ?? noAuditLog;
    this.#sessionId = options.sessionId ?? 'session';
    this.#now = options.now ?? Date.now;
  }

  definitions() {
    return this.#registry.definitions();
  }

  describe(call: ToolCall): string {
    const tool = this.#registry.get(call.name);
    if (!tool) return '';
    const parsed = tool.schema.safeParse(parseJson(call.arguments).value);
    return parsed.success ? tool.describe(parsed.data) : '';
  }

  async run(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    const { denied, ...outcome } = await this.#run(call, signal);
    this.#audit.record({
      time: new Date().toISOString(),
      session: this.#sessionId,
      tool: call.name,
      label: this.describe(call),
      args: parseJson(call.arguments).value ?? call.arguments,
      outcome: denied ? 'denied' : outcome.ok ? 'ok' : 'failed',
      ...(outcome.summary !== undefined && { summary: outcome.summary }),
      durationMs: outcome.durationMs,
    });
    return denied ? { ...outcome, denied: true } : outcome;
  }

  async #run(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    const startedAt = this.#now();
    const fail = (message: string, summary = 'failed'): ToolOutcome => ({
      ok: false,
      output: `Error: ${message}`,
      summary,
      durationMs: this.#now() - startedAt,
    });

    // 1. look up
    const tool = this.#registry.get(call.name);
    if (!tool) {
      return fail(
        `Unknown tool "${call.name}". Available tools: ${this.#registry.names().join(', ')}.`,
        'unknown tool',
      );
    }

    // 2. parse
    const json = parseJson(call.arguments);
    if (!json.ok) {
      return fail(`The arguments for ${tool.name} are not valid JSON: ${json.error}`, 'bad JSON');
    }

    // 3. validate
    const parsed = tool.schema.safeParse(json.value);
    if (!parsed.success) {
      return fail(
        `Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}`,
        'invalid arguments',
      );
    }

    const onProgress = this.#onProgress;
    const ctx = {
      workspace: this.#workspace,
      signal,
      ...(onProgress && { onProgress: (text: string) => onProgress(call.id, text) }),
    };

    // 4. permission: anything that is not a pure read must pass the gate
    // Every call passes the gate. Reads too: the user may want to approve those as well.
    {
      let preview: ActionPreview;
      try {
        // Computing the preview also validates the action (e.g. "oldText not found"),
        // so the user is never asked to approve a change that can't happen.
        preview = tool.preview ? await tool.preview(parsed.data, ctx) : { kind: 'none' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(message, firstWords(message));
      }
      const decision = await this.#gate.check(
        { toolName: tool.name, risk: tool.risk, label: tool.describe(parsed.data), preview },
        signal,
      );
      if (decision.verdict === 'deny') {
        // Not an "Error:": a refusal is a normal outcome the model must respect.
        return {
          ok: false,
          output: decision.message,
          summary: decision.summary,
          durationMs: this.#now() - startedAt,
          denied: true,
        };
      }
    }

    // 5. execute (timed from here: the time the user spent deciding doesn't count)
    const executionStart = this.#now();
    try {
      const result = await tool.execute(parsed.data, ctx);
      return {
        ok: result.ok ?? true,
        output: truncate(result.output, this.#outputLimit),
        ...(result.summary !== undefined && { summary: result.summary }),
        durationMs: this.#now() - executionStart,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(message, firstWords(message));
    }
  }
}

function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string; value?: undefined } {
  // Some models send "" for a tool without arguments.
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Keep the start and the end (errors and summaries tend to be at the end). */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[… ${omitted} characters omitted …]\n\n${text.slice(-tail)}`;
}

function firstWords(message: string, max = 60): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
