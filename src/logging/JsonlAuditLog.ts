import fs from 'node:fs';
import path from 'node:path';
import { HEPH_DIR } from '../config/paths.js';
import { ensureGitignore } from '../sessions/SessionStore.js';
import type { AuditEntry, AuditLog } from './AuditLog.js';

const MAX_STRING = 500;

/**
 * Appends one JSON object per line to <workspace>/.heph/logs/audit-YYYY-MM-DD.jsonl.
 *
 * JSONL (JSON Lines) is ideal for logs: append-only, one entry per line, easy to
 * grep, easy to parse (`Get-Content … | ConvertFrom-Json`, `jq`).
 *
 * Logging must never break the agent, so write errors are swallowed (and
 * reported once via `onError`).
 */
export class JsonlAuditLog implements AuditLog {
  readonly #dir: string;
  readonly #onError: (error: unknown) => void;
  #failed = false;
  #prepared = false;

  constructor(workspaceRoot: string, onError: (error: unknown) => void = () => {}) {
    this.#dir = path.join(workspaceRoot, HEPH_DIR, 'logs');
    this.#onError = onError;
  }

  /** The file for today (local date). */
  get file(): string {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.#dir, `audit-${day}.jsonl`);
  }

  record(entry: AuditEntry): void {
    if (this.#failed) return;
    try {
      this.#prepare();
      fs.appendFileSync(
        this.file,
        `${JSON.stringify({ ...entry, args: shorten(entry.args) })}\n`,
        'utf8',
      );
    } catch (error) {
      this.#failed = true;
      this.#onError(error);
    }
  }

  /** Create the folder and make sure logs never end up in git. */
  #prepare(): void {
    if (this.#prepared) return;
    fs.mkdirSync(this.#dir, { recursive: true });
    ensureGitignore(path.dirname(this.#dir));
    this.#prepared = true;
  }
}

/** Keep logs small: long strings (e.g. whole file contents for write_file) are cut. */
export function shorten(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  }
  return value;
}
