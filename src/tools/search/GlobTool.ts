import { z } from 'zod';
import { WorkspaceError } from '../../workspace/WorkspaceError.js';
import type { Tool, ToolContext, ToolResult } from '../Tool.js';

const schema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.ts", "src/**/*.test.ts", "*.md".'),
  path: z.string().default('.').describe('Folder to search in, relative to the workspace root.'),
});
type Args = z.infer<typeof schema>;

const MAX_RESULTS = 200;

export class GlobTool implements Tool<Args> {
  readonly name = 'glob';
  readonly description =
    'Find files by name pattern. Returns workspace-relative paths, sorted. ' +
    'Use it to locate files before reading them.';
  readonly schema = schema;
  readonly risk = 'read' as const;

  describe(args: Args): string {
    return args.path === '.' ? args.pattern : `${args.pattern} in ${args.path}`;
  }

  async execute(args: Args, { workspace }: ToolContext): Promise<ToolResult> {
    // fast-glob would happily follow "../" or an absolute pattern out of the workspace.
    if (/(^|[\\/])\.\.([\\/]|$)/.test(args.pattern) || /^([a-zA-Z]:)?[\\/]/.test(args.pattern)) {
      throw new WorkspaceError(
        'The pattern must be relative and must not contain "..". Use the path argument to pick a folder.',
      );
    }

    const files = await workspace.findFiles(args.pattern, args.path, MAX_RESULTS + 1);
    if (files.length === 0)
      return { output: `No files match "${args.pattern}".`, summary: '0 files' };

    const shown = files.slice(0, MAX_RESULTS);
    const more =
      files.length > MAX_RESULTS
        ? `\n[More than ${MAX_RESULTS} files. Use a narrower pattern.]`
        : '';
    return {
      output: shown.join('\n') + more,
      summary: `${shown.length}${more ? '+' : ''} files`,
    };
  }
}
