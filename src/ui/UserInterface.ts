import type { AgentEvent } from '../core/agent/AgentEvents.js';

/**
 * Small, separate interfaces instead of one big "UI" (Interface Segregation).
 * The REPL needs all three. A future `heph run` (non-interactive) needs only
 * OutputSink. M3's permission prompts will add an `Approver` interface.
 */

/** Where lines of user input come from. */
export interface InputSource {
  /** Resolves with the next line, or `null` when input has ended (Ctrl+D / EOF / closed). */
  readLine(): Promise<string | null>;
}

/** Where everything heph shows to the user goes. */
export interface OutputSink {
  render(event: AgentEvent): void;
  info(message: string): void;
  warn(message: string): void;
  error(error: unknown): void;
}

/** Lets the REPL react to Ctrl+C while a turn is running. */
export interface InterruptSource {
  /** Registers a handler. Returns a function that unregisters it. */
  onInterrupt(handler: () => void): () => void;
}
