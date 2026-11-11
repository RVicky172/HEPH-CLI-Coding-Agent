import { z } from 'zod';
import type { ActionPreview } from '../../permissions/ApprovalRequest.js';
import type { WorkspaceWriter } from '../../workspace/WorkspaceWriter.js';
import type { Tool, ToolResult } from '../Tool.js';
import { createDiffPreview, matchLineEndings, toLf } from './diffPreview.js';

const schema = z.object({
  path: z.string().min(1).describe('File to create or overwrite, relative to the workspace root.'),
  content: z.string().describe('The COMPLETE new content of the file.'),
});
type Args = z.infer<typeof schema>;

export class WriteFileTool implements Tool<Args> {
  readonly name = 'write_file';
  readonly description =
    'Create a new file, or replace an existing file completely. The user must approve the change. ' +
    'For changes to an existing file prefer edit_file. Only use write_file on an existing file ' +
    'when rewriting most of it, and read it first.';
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
    const { before, after, relative } = await this.#plan(args);
    return createDiffPreview(relative, before, after);
  }

  async execute(args: Args): Promise<ToolResult> {
    const { before, after, relative } = await this.#plan(args);
    if (before !== undefined && toLf(before) === toLf(after)) {
      return { output: `No change: ${relative} already has this content.`, summary: 'no change' };
    }
    const diff = createDiffPreview(relative, before, after);
    await this.#writer.write(args.path, after, this.name);
    return {
      output: `${diff.isNewFile ? 'Created' : 'Rewrote'} ${relative} (+${diff.added} -${diff.removed} lines).`,
      summary: `${diff.isNewFile ? 'created · ' : ''}+${diff.added} −${diff.removed}`,
    };
  }

  async #plan(args: Args) {
    const file = await this.#writer.load(args.path);
    return {
      relative: file.relative,
      before: file.text,
      after: matchLineEndings(file.text, args.content),
    };
  }
}
