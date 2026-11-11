import type { Agent } from '../../core/agent/Agent.js';
import type { PermissionMode, ReadPolicy } from '../../permissions/PermissionMode.js';
import type { OutputSink } from '../UserInterface.js';

export type SlashCommandResult = 'continue' | 'exit';

/** Session-level controls slash commands may use, without knowing the concrete classes. */
export interface SessionControls {
  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;
  /** Whether file reads ask first. */
  readonly reads: ReadPolicy;
  /** Tools the user said "always" to in this session. */
  readonly sessionGrants: readonly string[];
  clearSessionGrants(): void;
  /** Reverts the most recent file change. Returns a description, or undefined if nothing to undo. */
  undo(): Promise<string | undefined>;
}

export interface SlashCommandContext {
  readonly agent: Agent;
  readonly output: OutputSink;
  readonly session: SessionControls;
  readonly commands: readonly SlashCommand[];
}

/**
 * A REPL command like /help. Each one is its own small object. Adding a
 * command means adding one object and one line in the registry list (Open/Closed).
 */
export interface SlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly usage?: string;
  readonly description: string;
  run(args: string, ctx: SlashCommandContext): SlashCommandResult | Promise<SlashCommandResult>;
}
