import { z } from 'zod';
import { WorkspaceError } from '../../workspace/WorkspaceError.js';
import type { Tool, ToolContext, ToolResult } from '../Tool.js';

const schema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      'JavaScript regular expression to search for, e.g. "createProgram" or "function\\s+\\w+".',
    ),
  path: z
    .string()
    .default('.')
    .describe('File or folder to search, relative to the workspace root.'),
  include: z.string().optional().describe('Only search files matching this glob, e.g. "**/*.ts".'),
  ignoreCase: z.boolean().default(false).describe('Case-insensitive search.'),
});
type Args = z.infer<typeof schema>;

const MAX_MATCHES = 100;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 300;

/**
 * Pure-JS grep. A nice later exercise: use ripgrep when it is installed
 * (much faster) and fall back to this one (Strategy pattern).
 */
export class GrepTool implements Tool<Args> {
  readonly name = 'grep';
  readonly description =
    'Search file contents with a regular expression. Returns matches as "path:line: text". ' +
    'Use it to find where something is defined or used.';
  readonly schema = schema;
  readonly risk = 'read' as const;

  describe(args: Args): string {
    const where = args.path === '.' ? '' : ` in ${args.path}`;
    return `/${args.pattern}/${args.ignoreCase ? 'i' : ''}${where}${args.include ? ` (${args.include})` : ''}`;
  }

  async execute(args: Args, { workspace, signal }: ToolContext): Promise<ToolResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.ignoreCase ? 'i' : '');
    } catch (error) {
      throw new WorkspaceError(`Invalid regular expression: ${(error as Error).message}`);
    }

    const info = await workspace.stat(args.path);
    if (!info) throw new WorkspaceError(`"${args.path}" does not exist.`);
    const files = info.isFile
      ? [workspace.resolve(args.path).relative]
      : await workspace.findFiles(args.include ?? '**/*', args.path, MAX_FILES);

    const matches: string[] = [];
    const filesWithMatches = new Set<string>();

    for (const file of files) {
      if (signal.aborted || matches.length >= MAX_MATCHES) break;
      if (workspace.rules.isSensitive(file)) continue; // never search secrets

      const stat = await workspace.stat(file);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const buffer = await workspace.readFile(file);
      if (buffer.subarray(0, 8000).includes(0)) continue; // binary

      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        const line = lines[i] ?? '';
        if (!regex.test(line)) continue;
        filesWithMatches.add(file);
        const text = line.trim();
        matches.push(
          `${file}:${i + 1}: ${text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text}`,
        );
      }
    }

    if (matches.length === 0)
      return { output: `No matches for /${args.pattern}/.`, summary: '0 matches' };
    const capped = matches.length >= MAX_MATCHES;
    return {
      output:
        matches.join('\n') +
        (capped ? `\n[Stopped at ${MAX_MATCHES} matches. Narrow the search.]` : ''),
      summary: `${matches.length}${capped ? '+' : ''} matches in ${filesWithMatches.size} files`,
    };
  }
}
