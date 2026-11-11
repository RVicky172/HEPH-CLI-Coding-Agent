import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** Never worth showing to the model: huge, generated, or VCS internals. */
const ALWAYS_SKIPPED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.heph',
  'target',
];

/**
 * Files that commonly hold secrets. heph refuses to READ them, even though
 * listings may show that they exist (knowing ".env exists" is harmless and useful).
 */
const SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '*.kdbx',
  'credentials.json',
  '.git/**',
];

/**
 * Decides which workspace paths are hidden (ignored) and which are blocked (sensitive).
 * Paths are workspace-relative with forward slashes, e.g. "src/app.ts".
 */
export class IgnoreRules {
  readonly #ignored: Ignore;
  readonly #sensitive: Ignore;

  constructor(gitignoreContent = '') {
    this.#ignored = ignore()
      .add(ALWAYS_SKIPPED_DIRS.map((d) => `${d}/`))
      .add(gitignoreContent);
    this.#sensitive = ignore().add(SENSITIVE_PATTERNS);
  }

  /** Reads <root>/.gitignore if there is one. (Nested .gitignore files: a later improvement.) */
  static load(root: string): IgnoreRules {
    let content = '';
    try {
      content = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    } catch {
      // no .gitignore: fine
    }
    return new IgnoreRules(content);
  }

  /** Hidden from listings and searches. `isDirectory` matters for patterns like "dist/". */
  isIgnored(relativePath: string, isDirectory = false): boolean {
    if (relativePath === '.' || relativePath === '') return false;
    return this.#ignored.ignores(isDirectory ? `${relativePath}/` : relativePath);
  }

  /** Must never be read. */
  isSensitive(relativePath: string): boolean {
    if (relativePath === '.' || relativePath === '') return false;
    return this.#sensitive.ignores(relativePath);
  }

  /** Directory names fast-glob can skip without even entering them (performance). */
  static get skippedDirGlobs(): string[] {
    return ALWAYS_SKIPPED_DIRS.map((d) => `**/${d}/**`);
  }
}
