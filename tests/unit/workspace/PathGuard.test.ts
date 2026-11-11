import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathGuard, isInside } from '../../../src/workspace/PathGuard.js';
import { PathOutsideWorkspaceError } from '../../../src/workspace/WorkspaceError.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

/**
 * SECURITY TESTS: heph must never touch anything outside the workspace,
 * in ANY mode. If one of these fails, do not ship.
 */
describe('PathGuard (workspace boundary)', () => {
  let outer: string;
  let root: string;
  let guard: PathGuard;

  beforeEach(() => {
    outer = createTempDir({ 'project/src/app.ts': 'x', 'secret.txt': 'TOP SECRET' });
    root = path.join(outer, 'project');
    guard = new PathGuard(root);
  });
  afterEach(() => removeTempDir(outer));

  it('allows paths inside the workspace', () => {
    expect(guard.resolve('src/app.ts')).toBe(path.join(root, 'src', 'app.ts'));
    expect(guard.resolve('.')).toBe(path.resolve(root));
    expect(guard.resolve('./src/../src/app.ts')).toBe(path.join(root, 'src', 'app.ts'));
    expect(guard.resolve('does/not/exist/yet.ts')).toBe(
      path.join(root, 'does', 'not', 'exist', 'yet.ts'),
    );
  });

  it('allows an absolute path that points inside the workspace', () => {
    expect(guard.resolve(path.join(root, 'src', 'app.ts'))).toBe(path.join(root, 'src', 'app.ts'));
  });

  it('BLOCKS escaping with ".."', () => {
    expect(() => guard.resolve('../secret.txt')).toThrow(PathOutsideWorkspaceError);
    expect(() => guard.resolve('src/../../secret.txt')).toThrow(PathOutsideWorkspaceError);
  });

  it('BLOCKS absolute paths outside the workspace', () => {
    expect(() => guard.resolve(path.join(outer, 'secret.txt'))).toThrow(PathOutsideWorkspaceError);
    expect(() =>
      guard.resolve(process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'),
    ).toThrow(PathOutsideWorkspaceError);
  });

  it('BLOCKS a sibling folder whose name starts with the workspace name', () => {
    fs.mkdirSync(path.join(outer, 'project-evil'));
    expect(() => guard.resolve('../project-evil/x')).toThrow(PathOutsideWorkspaceError);
    expect(isInside(root, `${root}-evil`)).toBe(false);
  });

  it('BLOCKS a symlink/junction inside the project that points outside it', () => {
    const link = path.join(root, 'sneaky');
    // 'junction' works on Windows without admin rights; it's a plain dir symlink elsewhere.
    fs.symlinkSync(outer, link, 'junction');
    expect(() => guard.resolve('sneaky/secret.txt')).toThrow(PathOutsideWorkspaceError);
  });

  it('rejects NUL bytes', () => {
    expect(() => guard.resolve('src/app.ts\0.png')).toThrow();
  });

  it('relative() gives forward-slash workspace paths', () => {
    expect(guard.relative(path.join(root, 'src', 'app.ts'))).toBe('src/app.ts');
    expect(guard.relative(root)).toBe('.');
  });
});
