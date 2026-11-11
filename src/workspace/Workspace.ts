import fs from 'node:fs/promises';
import fg from 'fast-glob';
import { IgnoreRules } from './IgnoreRules.js';
import { PathGuard } from './PathGuard.js';
import { SensitivePathError } from './WorkspaceError.js';

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FileInfo {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * READ-ONLY access to the project folder, the only door tools have to your files.
 *
 * Every method takes a path from the model, runs it through PathGuard (stay
 * inside the root) and the sensitive-file rules, and only then touches the disk.
 * Read tools receive this. They CANNOT write, because there's no write method.
 * (M3 adds a separate WorkspaceWriter, given only to write tools: Interface Segregation.)
 */
export class Workspace {
  readonly guard: PathGuard;
  readonly rules: IgnoreRules;

  constructor(guard: PathGuard, rules: IgnoreRules) {
    this.guard = guard;
    this.rules = rules;
  }

  static open(root: string): Workspace {
    const guard = new PathGuard(root);
    return new Workspace(guard, IgnoreRules.load(guard.root));
  }

  get root(): string {
    return this.guard.root;
  }

  /** Validates a model-supplied path. Returns absolute and display (relative) forms. */
  resolve(requested: string): { absolute: string; relative: string } {
    // Models often mean "the project root" when they send "/" or "". Treat it that way
    // instead of failing (on Windows "/" would be the drive root).
    const normalized =
      requested.trim() === '' || requested === '/' || requested === '\\' ? '.' : requested;
    const absolute = this.guard.resolve(normalized);
    return { absolute, relative: this.guard.relative(absolute) };
  }

  async stat(requested: string): Promise<FileInfo | undefined> {
    const { absolute } = this.resolve(requested);
    try {
      const s = await fs.stat(absolute);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return undefined;
    }
  }

  async readFile(requested: string): Promise<Buffer> {
    const { absolute, relative } = this.resolve(requested);
    if (this.rules.isSensitive(relative)) throw new SensitivePathError(relative);
    return fs.readFile(absolute);
  }

  /** Entries of one directory, minus ignored ones. */
  async readDir(requested: string): Promise<DirEntry[]> {
    const { absolute, relative } = this.resolve(requested);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    const base = relative === '.' ? '' : `${relative}/`;
    return entries
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
      .filter((e) => !this.rules.isIgnored(base + e.name, e.isDirectory));
  }

  /**
   * Files matching a glob, as workspace-relative paths, skipping ignored ones.
   * `pattern` is relative to `base` (default: root).
   */
  async findFiles(pattern: string, base = '.', limit = 1000): Promise<string[]> {
    const { absolute: cwd, relative: baseRel } = this.resolve(base);
    const prefix = baseRel === '.' ? '' : `${baseRel}/`;
    const matches = await fg(pattern, {
      cwd,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false, // a link could lead outside the workspace
      ignore: IgnoreRules.skippedDirGlobs,
      suppressErrors: true,
    });
    const files: string[] = [];
    for (const m of matches.sort()) {
      const rel = prefix + m;
      if (this.rules.isIgnored(rel)) continue;
      files.push(rel);
      if (files.length >= limit) break;
    }
    return files;
  }
}
