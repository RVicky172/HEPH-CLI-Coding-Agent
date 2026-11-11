/** One recorded tool call: what was asked, what was decided, what happened. */
export interface AuditEntry {
  readonly time: string;
  readonly session: string;
  readonly tool: string;
  /** Short label, e.g. the path or the command. */
  readonly label: string;
  /** The model's arguments (long strings shortened). */
  readonly args: unknown;
  /** ok = ran and succeeded · failed = ran (or tried) and failed · denied = not allowed to run */
  readonly outcome: 'ok' | 'failed' | 'denied';
  readonly summary?: string;
  readonly durationMs: number;
}

/**
 * Where tool calls are recorded. Lets you answer "what did the agent do?"
 * after the fact. Implemented by JsonlAuditLog; tests use an in-memory one.
 */
export interface AuditLog {
  record(entry: AuditEntry): void;
}

export const noAuditLog: AuditLog = { record: () => {} };
