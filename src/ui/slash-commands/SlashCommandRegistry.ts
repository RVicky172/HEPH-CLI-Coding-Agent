import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './SlashCommand.js';

/** Finds and runs a slash command from a line like "/model qwen3". */
export class SlashCommandRegistry {
  readonly #commands: readonly SlashCommand[];
  readonly #byName = new Map<string, SlashCommand>();

  constructor(commands: readonly SlashCommand[]) {
    this.#commands = commands;
    for (const command of commands) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        if (this.#byName.has(name)) throw new Error(`Duplicate slash command: /${name}`);
        this.#byName.set(name, command);
      }
    }
  }

  /** Single-line input starting with "/". A multi-line paste that starts with a path is a message. */
  static isCommand(line: string): boolean {
    return line.startsWith('/') && !line.includes('\n');
  }

  async execute(
    line: string,
    ctx: Omit<SlashCommandContext, 'commands'>,
  ): Promise<SlashCommandResult> {
    const [rawName = '', ...rest] = line.slice(1).trim().split(/\s+/);
    const name = rawName.toLowerCase();
    const command = this.#byName.get(name) ?? this.#uniquePrefixMatch(name);
    if (!command) {
      const candidates = this.#commands
        .filter((c) => c.name.startsWith(name))
        .map((c) => `/${c.name}`);
      ctx.output.warn(
        candidates.length > 1
          ? `"/${name}" could be ${candidates.join(' or ')}. Type a bit more.`
          : `Unknown command "/${name}". Type / to see commands.`,
      );
      return 'continue';
    }
    return command.run(rest.join(' '), { ...ctx, commands: this.#commands });
  }

  /** "/mo" → /mode when exactly one command starts with it. */
  #uniquePrefixMatch(prefix: string): SlashCommand | undefined {
    if (!prefix) return undefined;
    const matches = this.#commands.filter((c) => c.name.startsWith(prefix));
    return matches.length === 1 ? matches[0] : undefined;
  }
}
