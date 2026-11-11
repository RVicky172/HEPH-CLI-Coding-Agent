import { z } from 'zod';
import { WorkspaceError } from '../../workspace/WorkspaceError.js';
import type { FileReadTracker } from '../../workspace/FileReadTracker.js';
import type { Tool, ToolContext, ToolResult } from '../Tool.js';

const schema = z.object({
  path: z.string().min(1).describe('File to read, relative to the workspace root.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start reading from (for large files).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe('Maximum number of lines to return (default 2000).'),
});
type Args = z.infer<typeof schema>;

const DEFAULT_LIMIT = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 2000;

export class ReadFileTool implements Tool<Args> {
  readonly name = 'read_file';
  readonly description =
    'Read a text file. Returns its lines prefixed with line numbers ("12\\tcode"). ' +
    'Line numbers are NOT part of the file. Always read a file before explaining or ' +
    'discussing its contents. Never guess what a file contains.';
  readonly schema = schema;
  readonly risk = 'read' as const;
  readonly #reads: FileReadTracker | undefined;

  /** The tracker records what was read, so edit tools can refuse blind or stale edits. */
  constructor(reads?: FileReadTracker) {
    this.#reads = reads;
  }

  describe(args: Args): string {
    return args.offset ? `${args.path}:${args.offset}` : args.path;
  }

  async execute(args: Args, { workspace }: ToolContext): Promise<ToolResult> {
    const info = await workspace.stat(args.path);
    if (!info) {
      throw new WorkspaceError(
        `File not found: "${args.path}". Use glob or list_directory to find it.`,
      );
    }
    if (info.isDirectory) {
      throw new WorkspaceError(`"${args.path}" is a directory. Use list_directory instead.`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        `"${args.path}" is too large (${Math.round(info.size / 1024)} KB). Use grep to find the relevant part.`,
      );
    }

    const buffer = await workspace.readFile(args.path); // also blocks secrets like .env
    this.#reads?.record(workspace.resolve(args.path).relative, info.mtimeMs);
    if (isBinary(buffer)) throw new WorkspaceError(`"${args.path}" is a binary file.`);

    const raw = buffer.toString('utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip a UTF-8 BOM
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop(); // trailing newline isn't an extra line
    if (lines.length === 0) return { output: '(empty file)', summary: 'empty' };

    const start = args.offset ?? 1;
    if (start > lines.length) {
      throw new WorkspaceError(
        `offset ${start} is past the end. The file has ${lines.length} lines.`,
      );
    }
    const end = Math.min(lines.length, start + (args.limit ?? DEFAULT_LIMIT) - 1);
    const width = String(end).length;

    const body = lines
      .slice(start - 1, end)
      .map((line, i) => {
        const clipped =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`
            : line;
        return `${String(start + i).padStart(width)}\t${clipped}`;
      })
      .join('\n');

    const partial = start > 1 || end < lines.length;
    const footer = partial
      ? `\n\n[Showing lines ${start}-${end} of ${lines.length}.${end < lines.length ? ` Use offset=${end + 1} to read more.` : ''}]`
      : '';

    return {
      output: body + footer,
      summary: partial ? `lines ${start}-${end} of ${lines.length}` : `${lines.length} lines`,
    };
  }
}

/** Text files don't contain NUL bytes. Checking the first 8 KB is the classic heuristic (git uses it too). */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}
