import { z } from 'zod';
import type { ActionPreview } from '../../permissions/ApprovalRequest.js';
import { WorkspaceError } from '../../workspace/WorkspaceError.js';
import type { WorkspaceWriter } from '../../workspace/WorkspaceWriter.js';
import type { Tool, ToolResult } from '../Tool.js';
import { createDiffPreview, matchLineEndings, toLf } from './diffPreview.js';

const schema = z.object({
  path: z.string().min(1).describe('File to edit, relative to the workspace root.'),
  oldText: z
    .string()
    .min(1)
    .describe(
      'Exact text to replace, copied from read_file output WITHOUT the line-number prefix. ' +
        'Must match the file exactly (including indentation) and be unique: include a few ' +
        'surrounding lines if needed.',
    ),
  newText: z.string().describe('Text to put in its place (may be empty to delete).'),
  replaceAll: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence instead of requiring exactly one.'),
});
type Args = z.infer<typeof schema>;

/**
 * Exact-snippet replacement: the editing strategy production agents use.
 *
 * Why not line numbers? They shift after every edit.
 * Why not rewrite the whole file? Slow, expensive, and models silently drop code.
 * Requiring a UNIQUE exact match means the model must know precisely what it's changing.
 */
export class EditFileTool implements Tool<Args> {
  readonly name = 'edit_file';
  readonly description =
    'Change part of an existing file by replacing an exact snippet (oldText) with newText. ' +
    'You MUST read_file the file first. The user must approve the change. ' +
    'Prefer several small edits over one huge one.';
  readonly schema = schema;
  readonly risk = 'write' as const;
  readonly #writer: WorkspaceWriter;

  constructor(writer: WorkspaceWriter) {
    this.#writer = writer;
  }

  describe(args: Args): string {
    return args.path;
  }

  async preview(args: Args): Promise<ActionPreview> {
    const { relative, before, after } = await this.#plan(args);
    return createDiffPreview(relative, before, after);
  }

  async execute(args: Args): Promise<ToolResult> {
    const { relative, before, after, count } = await this.#plan(args);
    const diff = createDiffPreview(relative, before, after);
    await this.#writer.write(args.path, after, this.name);
    return {
      output:
        `Edited ${relative}: replaced ${count} occurrence${count === 1 ? '' : 's'} ` +
        `(+${diff.added} -${diff.removed} lines).`,
      summary: `+${diff.added} −${diff.removed}`,
    };
  }

  async #plan(args: Args) {
    const file = await this.#writer.load(args.path);
    if (!file.exists || file.text === undefined) {
      throw new WorkspaceError(
        `File not found: "${args.path}". Use write_file to create a new file.`,
      );
    }

    // Compare with normalised line endings, then restore the file's own style.
    const text = toLf(file.text);
    const oldText = toLf(args.oldText);
    const newText = toLf(args.newText);
    if (oldText === newText)
      throw new WorkspaceError('oldText and newText are identical: nothing to change.');

    const count = countOccurrences(text, oldText);
    if (count === 0) throw new WorkspaceError(notFoundMessage(file.relative, text, oldText));
    if (count > 1 && !args.replaceAll) {
      throw new WorkspaceError(
        `oldText appears ${count} times in ${file.relative}. Include more surrounding lines so it is unique, ` +
          'or set replaceAll to true.',
      );
    }

    // split/join (and a replacer function) avoid "$&"-style surprises of String.replace.
    const replaced = args.replaceAll
      ? text.split(oldText).join(newText)
      : text.replace(oldText, () => newText);

    return {
      relative: file.relative,
      before: file.text,
      after: matchLineEndings(file.text, replaced),
      count: args.replaceAll ? count : 1,
    };
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + search.length)) count++;
  return count;
}

/** Explain WHY the match failed. That helps small models fix their next attempt. */
function notFoundMessage(relative: string, text: string, oldText: string): string {
  const base = `oldText was not found in ${relative}.`;
  if (/^\s*\d+\t/m.test(oldText)) {
    return `${base} It contains line-number prefixes from read_file ("12<TAB>"). Remove them.`;
  }
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (squash(text).includes(squash(oldText))) {
    return `${base} It matches only if whitespace is ignored: copy the exact indentation and line breaks.`;
  }
  return `${base} Read the file again and copy the exact text.`;
}
