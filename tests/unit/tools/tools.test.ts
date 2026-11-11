import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListDirectoryTool } from '../../../src/tools/fs/ListDirectoryTool.js';
import { ReadFileTool } from '../../../src/tools/fs/ReadFileTool.js';
import { GlobTool } from '../../../src/tools/search/GlobTool.js';
import { GrepTool } from '../../../src/tools/search/GrepTool.js';
import type { Tool, ToolContext } from '../../../src/tools/Tool.js';
import { Workspace } from '../../../src/workspace/Workspace.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

let root: string;
let ctx: ToolContext;

beforeAll(() => {
  root = createTempDir({
    'README.md': '# Demo\n\nA demo project.\n',
    'src/app.ts': 'import { add } from "./math";\nconsole.log(add(1, 2));\n',
    'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    'src/math.test.ts': 'import { add } from "./math";\n',
    'src/big.txt': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'),
    'node_modules/lib/index.js': 'export function add() {}',
    'dist/app.js': 'compiled add()',
    'debug.log': 'add log',
    '.gitignore': '*.log\n',
    '.env': 'OPENAI_API_KEY=sk-super-secret',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
    'windows.txt': 'one\r\ntwo\r\n',
  });
  ctx = { workspace: Workspace.open(root), signal: new AbortController().signal };
});
afterAll(() => removeTempDir(root));

/** Run a tool the way the executor does: validate args with its schema first. */
async function run<T>(tool: Tool<T>, args: unknown) {
  return tool.execute(tool.schema.parse(args), ctx);
}

describe('list_directory', () => {
  const tool = new ListDirectoryTool();

  it('shows a tree, folders first, hiding node_modules, dist and .gitignore entries', async () => {
    const { output, summary } = await run(tool, {});
    expect(output.split('\n')[0]).toBe('./');
    expect(output).toContain('  src/\n    app.ts');
    expect(output).toContain('README.md');
    expect(output).not.toContain('node_modules');
    expect(output).not.toContain('dist');
    expect(output).not.toContain('debug.log');
    expect(summary).toMatch(/entries/);
  });

  it('depth=1 does not descend into folders', async () => {
    const { output } = await run(tool, { depth: 1 });
    expect(output).toContain('src/');
    expect(output).not.toContain('app.ts');
  });

  it('"/" means the workspace root, not the drive root', async () => {
    const { output } = await run(tool, { path: '/' });
    expect(output).toContain('README.md');
  });

  it('errors clearly on a file or a missing folder', async () => {
    await expect(run(tool, { path: 'README.md' })).rejects.toThrow(/use read_file/i);
    await expect(run(tool, { path: 'nope' })).rejects.toThrow(/does not exist/);
  });

  it('cannot list outside the workspace', async () => {
    await expect(run(tool, { path: '..' })).rejects.toThrow(/outside the workspace/);
  });
});

describe('read_file', () => {
  const tool = new ReadFileTool();

  it('returns numbered lines', async () => {
    const { output, summary } = await run(tool, { path: 'src/math.ts' });
    expect(output).toBe('1\texport function add(a: number, b: number) {\n2\t  return a + b;\n3\t}');
    expect(summary).toBe('3 lines');
  });

  it('supports offset/limit and says how to continue', async () => {
    const { output, summary } = await run(tool, { path: 'src/big.txt', offset: 10, limit: 5 });
    expect(output).toContain('10\tline 10');
    expect(output).toContain('14\tline 14');
    expect(output).not.toContain('line 15');
    expect(output).toContain('Use offset=15');
    expect(summary).toBe('lines 10-14 of 30');
  });

  it('handles Windows line endings', async () => {
    expect((await run(tool, { path: 'windows.txt' })).output).toBe('1\tone\n2\ttwo');
  });

  it('SECURITY: refuses to read .env (secrets)', async () => {
    await expect(run(tool, { path: '.env' })).rejects.toThrow(/may contain secrets/);
  });

  it('SECURITY: refuses paths outside the workspace', async () => {
    await expect(run(tool, { path: '../../etc/passwd' })).rejects.toThrow(/outside the workspace/);
  });

  it('refuses binary files and directories, with a hint', async () => {
    await expect(run(tool, { path: 'logo.png' })).rejects.toThrow(/binary/);
    await expect(run(tool, { path: 'src' })).rejects.toThrow(/list_directory/);
  });

  it('missing file suggests how to find it', async () => {
    await expect(run(tool, { path: 'src/nope.ts' })).rejects.toThrow(/glob or list_directory/);
  });
});

describe('glob', () => {
  const tool = new GlobTool();

  it('finds files by pattern, skipping ignored folders', async () => {
    const { output } = await run(tool, { pattern: '**/*.ts' });
    expect(output.split('\n')).toEqual(['src/app.ts', 'src/math.test.ts', 'src/math.ts']);
  });

  it('searches inside a sub folder and returns workspace-relative paths', async () => {
    const { output } = await run(tool, { pattern: '*.test.ts', path: 'src' });
    expect(output).toBe('src/math.test.ts');
  });

  it('SECURITY: rejects patterns that climb out with ".." or are absolute', async () => {
    await expect(run(tool, { pattern: '../**/*' })).rejects.toThrow(/must not contain/);
    await expect(run(tool, { pattern: '/etc/*' })).rejects.toThrow(/relative/);
  });

  it('reports no matches plainly', async () => {
    expect((await run(tool, { pattern: '**/*.py' })).summary).toBe('0 files');
  });
});

describe('grep', () => {
  const tool = new GrepTool();

  it('finds matches as path:line: text, skipping node_modules, dist and ignored files', async () => {
    const { output, summary } = await run(tool, { pattern: 'add\\(' });
    expect(output).toContain('src/app.ts:2: console.log(add(1, 2));');
    expect(output).not.toContain('node_modules');
    expect(output).not.toContain('dist/');
    expect(output).not.toContain('debug.log');
    expect(summary).toMatch(/matches in \d+ files/);
  });

  it('SECURITY: never searches inside .env', async () => {
    const { output } = await run(tool, { pattern: 'sk-super-secret' });
    expect(output).toMatch(/No matches/);
  });

  it('supports include, ignoreCase and a single file path', async () => {
    expect(
      (await run(tool, { pattern: 'DEMO', ignoreCase: true, include: '*.md' })).output,
    ).toContain('README.md:1');
    expect((await run(tool, { pattern: 'return', path: 'src/math.ts' })).output).toBe(
      'src/math.ts:2: return a + b;',
    );
  });

  it('invalid regex is a clear error', async () => {
    await expect(run(tool, { pattern: '(' })).rejects.toThrow(/Invalid regular expression/);
  });
});
