import fs from 'node:fs';
import path from 'node:path';
import { HEPH_DIR } from '../config/paths.js';
import { SUMMARY_MARKER } from '../core/context/ContextManager.js';
import type { Message } from '../core/conversation/Message.js';

export interface SavedSession {
  readonly id: string;
  /** First user message, shortened: shown in `heph sessions`. */
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: string;
  /** History WITHOUT the system prompt (that is rebuilt fresh on resume). */
  readonly messages: readonly Message[];
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

/**
 * Saves conversations to <workspace>/.heph/sessions/<id>.json so you can
 * continue later (`heph -c`). Sessions contain your code (file contents the
 * agent read), so they stay local and are git-ignored.
 */
export class SessionStore {
  readonly #dir: string;

  constructor(workspaceRoot: string) {
    this.#dir = path.join(workspaceRoot, HEPH_DIR, 'sessions');
  }

  static newId(now = new Date()): string {
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  }

  save(session: SavedSession): void {
    fs.mkdirSync(this.#dir, { recursive: true });
    ensureGitignore(path.dirname(this.#dir));
    // write-then-rename: a crash mid-write never leaves a half-written session
    const file = this.#file(session.id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(session, null, 1), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  }

  load(id: string): SavedSession | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.#file(id), 'utf8')) as SavedSession;
    } catch {
      return undefined;
    }
  }

  /** Most recently updated first. */
  list(): SessionSummary[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.#dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => this.load(f.slice(0, -5)))
      .filter((s): s is SavedSession => s !== undefined)
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  latest(): SavedSession | undefined {
    const first = this.list()[0];
    return first ? this.load(first.id) : undefined;
  }

  #file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid session id "${id}"`); // no path tricks
    return path.join(this.#dir, `${id}.json`);
  }
}

export function sessionTitle(messages: readonly Message[]): string {
  // Skip the summary that compaction puts first: the title should describe what the user asked.
  const first =
    messages.find((m) => m.role === 'user' && !m.content.startsWith(SUMMARY_MARKER))?.content ??
    '(compacted session)';
  const oneLine = first
    .replace(/\[Note from heph:[^\]]*\]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}

/** .heph/.gitignore must cover logs AND sessions (both contain project content). */
export function ensureGitignore(hephDir: string): void {
  const file = path.join(hephDir, '.gitignore');
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    content = '# heph runtime data (stays on your machine)\n';
  }
  let changed = false;
  for (const entry of ['logs/', 'sessions/']) {
    if (!content.split(/\r?\n/).includes(entry)) {
      content += `${content.endsWith('\n') ? '' : '\n'}${entry}\n`;
      changed = true;
    }
  }
  if (changed || !fs.existsSync(file)) fs.writeFileSync(file, content, 'utf8');
}
