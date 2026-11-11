import { z } from 'zod';
import type { ToolDefinition } from '../core/agent/ToolRunner.js';
import type { Tool } from './Tool.js';

/** The set of tools available in a session, plus their JSON Schema definitions for the model. */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  #definitions: ToolDefinition[] | undefined;

  constructor(tools: readonly Tool<never>[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register<T>(tool: Tool<T>): this {
    if (this.#tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
    this.#tools.set(tool.name, tool as unknown as Tool);
    this.#definitions = undefined;
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  /**
   * zod schema → JSON Schema, which the model reads to know which arguments exist.
   * `io: 'input'` makes fields with a default optional, as they are for the caller.
   */
  definitions(): readonly ToolDefinition[] {
    this.#definitions ??= [...this.#tools.values()].map((tool) => {
      const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input' });
      return { name: tool.name, description: tool.description, parameters };
    });
    return this.#definitions;
  }
}
