import type { TokenUsage } from '../../llm/LLMProvider.js';

/**
 * Everything the Agent reports while working on a turn.
 * The UI decides how to show each event. The Agent never prints anything itself.
 *
 * M3 adds: permission_requested.
 */
export type AgentEvent =
  /** The model is about to be called (step 1, 2, …). The UI shows a spinner. */
  | { readonly type: 'thinking'; readonly step: number }
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'reasoning'; readonly delta: string }
  | {
      readonly type: 'tool_start';
      readonly callId: string;
      readonly name: string;
      /** Short label, e.g. the path being read. */
      readonly label: string;
    }
  | {
      readonly type: 'tool_end';
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      /** The user (or a rule/mode) refused it: it never ran. */
      readonly denied?: boolean;
      readonly summary?: string;
      readonly durationMs: number;
    }
  | { readonly type: 'warning'; readonly message: string }
  /** The context is filling up: older turns are being summarised. */
  | { readonly type: 'compacting' }
  | {
      readonly type: 'compacted';
      readonly turns: number;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
    }
  /** This request was shortened to fit (old tool outputs elided / turns left out). */
  | { readonly type: 'context_trimmed'; readonly actions: readonly string[] }
  | {
      readonly type: 'turn_end';
      readonly durationMs: number;
      /** How many times the model was called during this turn. */
      readonly steps: number;
      /** Summed over all steps. */
      readonly usage?: TokenUsage;
      readonly finishReason?: string;
      /** How full the context window is after this turn. */
      readonly context?: { readonly usedTokens: number; readonly limitTokens: number };
    }
  | { readonly type: 'interrupted' }
  | { readonly type: 'error'; readonly error: unknown };
