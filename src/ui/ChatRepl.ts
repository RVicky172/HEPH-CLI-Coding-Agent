import type { Agent } from '../core/agent/Agent.js';
import type { SessionControls } from './slash-commands/SlashCommand.js';
import { SlashCommandRegistry } from './slash-commands/SlashCommandRegistry.js';
import type { InputSource, InterruptSource, OutputSink } from './UserInterface.js';

export interface ChatReplDeps {
  readonly agent: Agent;
  readonly input: InputSource;
  readonly output: OutputSink;
  readonly interrupts: InterruptSource;
  readonly commands: SlashCommandRegistry;
  readonly session: SessionControls;
  /** Called after every turn or command, e.g. to autosave the session. */
  readonly afterEach?: () => void;
}

/**
 * Read → Evaluate → Print → Loop.
 * Its one job is coordination: read a line, route it to a slash command or
 * the Agent, and pipe the Agent's events to the output. Rendering and
 * thinking happen elsewhere.
 */
export class ChatRepl {
  readonly #deps: ChatReplDeps;

  constructor(deps: ChatReplDeps) {
    this.#deps = deps;
  }

  async run(): Promise<void> {
    const { input, output, agent, commands, session } = this.#deps;

    for (;;) {
      const line = await input.readLine();
      if (line === null) break; // Ctrl+D, EOF of piped input, or Ctrl+C at the prompt

      const text = line.trim();
      if (!text) continue;

      if (SlashCommandRegistry.isCommand(text)) {
        const result = await commands.execute(text, { agent, output, session });
        this.#deps.afterEach?.();
        if (result === 'exit') break;
        continue;
      }

      await this.#runTurn(text);
      this.#deps.afterEach?.();
    }
  }

  async #runTurn(text: string): Promise<void> {
    const { agent, output, interrupts } = this.#deps;
    const controller = new AbortController();
    const unsubscribe = interrupts.onInterrupt(() => controller.abort());
    try {
      for await (const event of agent.runTurn(text, controller.signal)) {
        output.render(event);
      }
    } finally {
      unsubscribe();
    }
  }
}
