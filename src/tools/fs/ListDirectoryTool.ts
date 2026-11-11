import { z } from 'zod';
import { WorkspaceError } from '../../workspace/WorkspaceError.js';
import type { Tool, ToolContext, ToolResult } from '../Tool.js';

const schema = z.object({
  path: z
    .string()
    .default('.')
    .describe('Directory to list, relative to the workspace root. "." is the root.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe('How many levels deep to list (1-5). Use 1 for big folders.'),
});
type Args = z.infer<typeof schema>;

const MAX_ENTRIES = 500;

export class ListDirectoryTool implements Tool<Args> {
  readonly name = 'list_directory';
  readonly description =
    'List files and folders as an indented tree (folders end with "/"). ' +
    'Ignores node_modules, .git, build output and .gitignore entries. ' +
    'Use this first to understand the project structure.';
  readonly schema = schema;
  readonly risk = 'read' as const;

  describe(args: Args): string {
    return args.path === '.' ? './' : args.path;
  }

  async execute(args: Args, { workspace, signal }: ToolContext): Promise<ToolResult> {
    const info = await workspace.stat(args.path);
    if (!info) throw new WorkspaceError(`"${args.path}" does not exist.`);
    if (!info.isDirectory) {
      throw new WorkspaceError(`"${args.path}" is a file, not a directory. Use read_file instead.`);
    }

    const { relative } = workspace.resolve(args.path);
    const lines: string[] = [relative === '.' ? './' : `${relative}/`];
    let count = 0;
    let truncated = false;

    const walk = async (dir: string, depth: number, indent: string): Promise<void> => {
      const entries = (await workspace.readDir(dir)).sort(
        (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (signal.aborted) return;
        if (count >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        count++;
        lines.push(`${indent}${entry.name}${entry.isDirectory ? '/' : ''}`);
        if (entry.isDirectory && depth > 1) {
          await walk(`${dir}/${entry.name}`, depth - 1, `${indent}  `);
        }
      }
    };

    await walk(relative, args.depth, '  ');

    if (count === 0) lines.push('  (empty)');
    if (truncated) {
      lines.push(
        `[Stopped after ${MAX_ENTRIES} entries. List a subfolder or use a smaller depth.]`,
      );
    }
    return { output: lines.join('\n'), summary: `${count} entries${truncated ? '+' : ''}` };
  }
}
