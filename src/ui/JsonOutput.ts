import type { AgentEvent } from '../core/agent/AgentEvents.js';
import { HephError } from '../core/errors/HephError.js';
import type { ApprovalRequest } from '../permissions/ApprovalRequest.js';
import type { ApprovalAnswer, Approver } from '../permissions/Approver.js';
import type { OutputSink } from './UserInterface.js';

/**
 * Machine-readable output for `heph run --json`: one JSON object per line.
 *
 *   {"type":"tool_start","name":"read_file","label":"README.md",…}
 *   {"type":"text","delta":"The README…"}
 *   {"type":"result","exitCode":0,"answer":"The README…"}
 *
 * The same OutputSink + Approver interfaces as the terminal UI. The Agent can't
 * tell the difference (Liskov Substitution). There is nobody to ask, so every
 * approval is refused unless the mode/rules allow it beforehand.
 */
export class JsonOutput implements OutputSink, Approver {
  readonly #write: (line: string) => void;

  constructor(write: (line: string) => void) {
    this.#write = write;
  }

  emit(object: Record<string, unknown>): void {
    this.#write(`${JSON.stringify(object)}\n`);
  }

  render(event: AgentEvent): void {
    if (event.type === 'error') {
      this.emit({ type: 'error', ...describeError(event.error) });
      return;
    }
    this.emit({ ...event });
  }

  info(message: string): void {
    this.emit({ type: 'info', message });
  }

  warn(message: string): void {
    this.emit({ type: 'warning', message });
  }

  error(error: unknown): void {
    this.emit({ type: 'error', ...describeError(error) });
  }

  async ask(request: ApprovalRequest): Promise<ApprovalAnswer> {
    this.emit({
      type: 'approval_denied',
      tool: request.toolName,
      label: request.label,
      reason: 'non-interactive',
    });
    return { decision: 'deny', reason: 'non_interactive' };
  }

  show(request: ApprovalRequest, note: string): void {
    this.emit({ type: 'auto_approved', tool: request.toolName, label: request.label, note });
  }
}

function describeError(error: unknown): { message: string; hint?: string } {
  if (error instanceof HephError)
    return { message: error.message, ...(error.hint && { hint: error.hint }) };
  return { message: error instanceof Error ? error.message : String(error) };
}
