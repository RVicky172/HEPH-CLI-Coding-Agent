import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalAnswer } from '../../../src/permissions/Approver.js';
import type { PermissionMode } from '../../../src/permissions/PermissionMode.js';
import { PolicyPermissionGate } from '../../../src/permissions/PolicyPermissionGate.js';
import { EditFileTool } from '../../../src/tools/fs/EditFileTool.js';
import { ReadFileTool } from '../../../src/tools/fs/ReadFileTool.js';
import { WriteFileTool } from '../../../src/tools/fs/WriteFileTool.js';
import { ToolExecutor } from '../../../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { CheckpointStore } from '../../../src/workspace/CheckpointStore.js';
import { FileReadTracker } from '../../../src/workspace/FileReadTracker.js';
import { Workspace } from '../../../src/workspace/Workspace.js';
import { WorkspaceWriter } from '../../../src/workspace/WorkspaceWriter.js';
import { FakeApprover } from '../../helpers/FakeApprover.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

const MATH = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';

let root: string;
beforeEach(() => {
  root = createTempDir({
    'src/math.ts': MATH,
    'src/crlf.ts': 'const a = 1;\r\nconst b = 2;\r\n',
    'src/dupes.ts': 'x();\nx();\n',
    '.env': 'SECRET=1',
  });
});
afterEach(() => removeTempDir(root));

/** The full stack exactly as the container wires it, with a scripted human. */
function setup(mode: PermissionMode = 'ask', answers: ApprovalAnswer[] = []) {
  const workspace = Workspace.open(root);
  const reads = new FileReadTracker();
  const checkpoints = new CheckpointStore();
  const writer = new WorkspaceWriter(workspace, checkpoints, reads);
  const approver = new FakeApprover(answers);
  const gate = new PolicyPermissionGate(approver, mode);
  const registry = new ToolRegistry()
    .register(new ReadFileTool(reads))
    .register(new EditFileTool(writer))
    .register(new WriteFileTool(writer));
  const executor = new ToolExecutor(registry, workspace, { gate });
  let n = 0;
  const run = (name: string, args: object) =>
    executor.run(
      { id: `c${++n}`, name, arguments: JSON.stringify(args) },
      new AbortController().signal,
    );
  return { run, approver, checkpoints, gate };
}

const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(root, rel));
const ADD_MULTIPLY = {
  path: 'src/math.ts',
  oldText: '  return a + b;\n}',
  newText:
    '  return a + b;\n}\n\nexport function multiply(a: number, b: number) {\n  return a * b;\n}',
};

describe('THE GUARANTEE: no change without approval in "ask" mode', () => {
  it('edit_file + user says NO → file unchanged, model told', async () => {
    const { run, approver } = setup('ask', [{ decision: 'deny' }]);
    await run('read_file', { path: 'src/math.ts' });
    const out = await run('edit_file', ADD_MULTIPLY);

    expect(read('src/math.ts')).toBe(MATH);
    expect(out).toMatchObject({ ok: false, summary: 'denied by you' });
    expect(out.output).toMatch(/user rejected/);
    expect(approver.asked).toHaveLength(1);
  });

  it('write_file (new file) + user says NO → no file created', async () => {
    const { run } = setup('ask', [{ decision: 'deny' }]);
    await run('write_file', { path: 'src/new.ts', content: 'x' });
    expect(exists('src/new.ts')).toBe(false);
  });

  it('read-only mode → refused without asking, nothing written', async () => {
    const { run, approver } = setup('read-only');
    await run('read_file', { path: 'src/math.ts' });
    const out = await run('edit_file', ADD_MULTIPLY);
    expect(read('src/math.ts')).toBe(MATH);
    expect(out.summary).toBe('blocked: read-only mode');
    expect(approver.asked).toHaveLength(0);
  });

  it('the user sees an accurate diff BEFORE deciding', async () => {
    const { run, approver } = setup('ask', [{ decision: 'deny' }]);
    await run('read_file', { path: 'src/math.ts' });
    await run('edit_file', ADD_MULTIPLY);
    const preview = approver.asked[0]?.preview;
    expect(preview).toMatchObject({
      kind: 'diff',
      path: 'src/math.ts',
      added: 4,
      removed: 0,
      isNewFile: false,
    });
    const added =
      preview?.kind === 'diff'
        ? preview.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add')
        : [];
    expect(added.map((l) => l.text)).toContain('export function multiply(a: number, b: number) {');
    expect(added[0]?.newLine).toBe(4);
  });
});

describe('edit_file', () => {
  it('applies the change after YES, and /undo restores the original', async () => {
    const { run, checkpoints } = setup('ask', [{ decision: 'allow' }]);
    await run('read_file', { path: 'src/math.ts' });
    const out = await run('edit_file', ADD_MULTIPLY);

    expect(out).toMatchObject({ ok: true, summary: '+4 −0' });
    expect(read('src/math.ts')).toContain('export function multiply');

    expect(await checkpoints.undoLast()).toMatchObject({
      relative: 'src/math.ts',
      action: 'restored',
    });
    expect(read('src/math.ts')).toBe(MATH);
  });

  it('refuses to edit a file the model has not read (no blind edits), without bothering the user', async () => {
    const { run, approver } = setup('ask');
    const out = await run('edit_file', ADD_MULTIPLY);
    expect(out.output).toMatch(/must read "src\/math.ts" with read_file/);
    expect(approver.asked).toHaveLength(0);
  });

  it('refuses a stale edit when the user changed the file after it was read', async () => {
    const { run } = setup('auto-edit');
    await run('read_file', { path: 'src/math.ts' });
    const file = path.join(root, 'src/math.ts');
    fs.writeFileSync(file, `${MATH}// user edit\n`);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // make sure mtime differs
    const out = await run('edit_file', ADD_MULTIPLY);
    expect(out.output).toMatch(/changed since you last read it/);
    expect(read('src/math.ts')).toContain('// user edit');
  });

  it('allows several edits in a row (its own writes keep the file "fresh")', async () => {
    const { run } = setup('auto-edit');
    await run('read_file', { path: 'src/math.ts' });
    expect(
      (await run('edit_file', { path: 'src/math.ts', oldText: 'a + b', newText: 'b + a' })).ok,
    ).toBe(true);
    expect(
      (await run('edit_file', { path: 'src/math.ts', oldText: 'add(', newText: 'sum(' })).ok,
    ).toBe(true);
    expect(read('src/math.ts')).toContain('function sum(a: number, b: number) {\n  return b + a;');
  });

  it('explains "not found", including the line-number-prefix mistake', async () => {
    const { run } = setup('auto-edit');
    await run('read_file', { path: 'src/math.ts' });
    expect(
      (await run('edit_file', { path: 'src/math.ts', oldText: 'nope', newText: 'x' })).output,
    ).toMatch(/not found/);
    expect(
      (await run('edit_file', { path: 'src/math.ts', oldText: '2\t  return a + b;', newText: 'x' }))
        .output,
    ).toMatch(/line-number prefixes/);
    expect(
      (await run('edit_file', { path: 'src/math.ts', oldText: 'return   a +   b;', newText: 'x' }))
        .output,
    ).toMatch(/whitespace/);
  });

  it('requires a unique match unless replaceAll is set', async () => {
    const { run } = setup('auto-edit');
    await run('read_file', { path: 'src/dupes.ts' });
    expect(
      (await run('edit_file', { path: 'src/dupes.ts', oldText: 'x();', newText: 'y();' })).output,
    ).toMatch(/appears 2 times/);
    expect(
      (
        await run('edit_file', {
          path: 'src/dupes.ts',
          oldText: 'x();',
          newText: 'y();',
          replaceAll: true,
        })
      ).ok,
    ).toBe(true);
    expect(read('src/dupes.ts')).toBe('y();\ny();\n');
  });

  it('keeps Windows CRLF line endings', async () => {
    const { run } = setup('auto-edit');
    await run('read_file', { path: 'src/crlf.ts' });
    await run('edit_file', {
      path: 'src/crlf.ts',
      oldText: 'const b = 2;',
      newText: 'const b = 3;\nconst c = 4;',
    });
    expect(read('src/crlf.ts')).toBe('const a = 1;\r\nconst b = 3;\r\nconst c = 4;\r\n');
  });

  it('newText with "$&" is inserted literally (no regex replacement surprises)', async () => {
    const { run } = setup('auto-edit');
    await run('read_file', { path: 'src/math.ts' });
    await run('edit_file', { path: 'src/math.ts', oldText: 'a + b', newText: "'$&' + a" });
    expect(read('src/math.ts')).toContain("return '$&' + a;");
  });
});

describe('write_file', () => {
  it('creates new files (and folders), and /undo deletes them again', async () => {
    const { run, checkpoints } = setup('ask', [{ decision: 'allow' }]);
    const out = await run('write_file', {
      path: 'src/util/new.ts',
      content: 'export const x = 1;\n',
    });
    expect(out).toMatchObject({ ok: true, summary: 'created · +1 −0' });
    expect(read('src/util/new.ts')).toBe('export const x = 1;\n');
    expect(await checkpoints.undoLast()).toMatchObject({ action: 'deleted' });
    expect(exists('src/util/new.ts')).toBe(false);
  });

  it('refuses to overwrite an existing file that was not read', async () => {
    const { run } = setup('auto-edit');
    const out = await run('write_file', { path: 'src/math.ts', content: 'oops' });
    expect(out.ok).toBe(false);
    expect(read('src/math.ts')).toBe(MATH);
  });
});

describe('SECURITY: things heph never writes, even when the user approves', () => {
  it.each([
    ['.env', 'may contain secrets'],
    ['.git/config', 'secrets|never modifies'],
    ['.heph/config.json', 'never modifies'],
    ['../outside.txt', 'outside the workspace'],
  ])('write_file %s → blocked', async (target, reason) => {
    const { run, approver } = setup('full-auto');
    const out = await run('write_file', { path: target, content: 'pwned' });
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(new RegExp(reason));
    expect(approver.asked).toHaveLength(0); // rejected before even asking
    expect(read('.env')).toBe('SECRET=1');
    expect(fs.existsSync(path.join(root, '..', 'outside.txt'))).toBe(false);
  });
});
