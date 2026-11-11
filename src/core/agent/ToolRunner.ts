import type { ToolCall } from '../conversation/Message.js';

/**
 * What the model is told about a tool: its name, when to use it, and the JSON
 * Schema of its arguments. This is ALL the model knows about our tools.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolOutcome {
  readonly ok: boolean;
  /** Sent back to the model as the tool result. */
  readonly output: string;
  /** Short human summary for the UI, e.g. "42 lines". */
  readonly summary?: string;
  readonly durationMs: number;
  /** true when the permission gate refused it (it never ran). */
  readonly denied?: boolean;
}

/**
 * The port between the Agent and the tool system (Dependency Inversion).
 * The Agent doesn't know which tools exist or how they work. It only knows
 * how to ask for definitions, a display label, and an outcome.
 * Implemented by tools/ToolExecutor.ts.
 */
export interface ToolRunner {
  definitions(): readonly ToolDefinition[];
  /** A short label for the UI, e.g. `src/app.ts` for read_file. */
  describe(call: ToolCall): string;
  /** Never throws: failures come back as `{ ok: false, output: "Error: …" }`. */
  run(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}
