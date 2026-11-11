import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates a real temporary folder with the given files, e.g.
 *   { 'src/a.ts': 'x', '.env': 'SECRET=1' }
 * Real files (instead of an in-memory fake) test exactly what users will hit,
 * including Windows path quirks and symlinks.
 */
export function createTempDir(files: Record<string, string | Buffer> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

export function removeTempDir(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
