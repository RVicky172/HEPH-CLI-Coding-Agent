import fs from 'node:fs';
import path from 'node:path';

/** Files heph reads as project rules, in priority order. AGENTS.md is a cross-tool convention. */
export const INSTRUCTION_FILES = ['HEPH.md', 'AGENTS.md'] as const;
const MAX_CHARS = 20_000;

export interface ProjectInstructions {
  readonly file: string;
  readonly content: string;
  readonly truncated: boolean;
}

/**
 * Loads the project's instructions for the agent ("use pnpm", "tests live in
 * __tests__", "never touch generated/"). They are added to the system prompt.
 *
 * NOTE: this file comes from the repository, so treat it as UNTRUSTED. It can
 * steer the model, but it can never change permissions: every action still
 * goes through the PermissionGate.
 */
export function loadProjectInstructions(root: string): ProjectInstructions | undefined {
  for (const file of INSTRUCTION_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (!content.trim()) continue;
    return content.length > MAX_CHARS
      ? { file, content: content.slice(0, MAX_CHARS), truncated: true }
      : { file, content, truncated: false };
  }
  return undefined;
}
