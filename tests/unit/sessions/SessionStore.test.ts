import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conversation } from '../../../src/core/conversation/Conversation.js';
import { SessionStore, ensureGitignore, sessionTitle } from '../../../src/sessions/SessionStore.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

let root: string;
beforeEach(() => {
  root = createTempDir();
});
afterEach(() => removeTempDir(root));

const session = (id: string, updatedAt: string) => ({
  id,
  title: `t-${id}`,
  createdAt: updatedAt,
  updatedAt,
  model: 'm',
  messages: [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
  ],
});

describe('SessionStore', () => {
  it('saves, loads and lists sessions (newest first), and git-ignores them', () => {
    const store = new SessionStore(root);
    store.save(session('a', '2026-01-01T10:00:00Z'));
    store.save(session('b', '2026-01-02T10:00:00Z'));

    expect(store.load('a')?.messages).toHaveLength(2);
    expect(store.list().map((s) => s.id)).toEqual(['b', 'a']);
    expect(store.latest()?.id).toBe('b');
    expect(fs.readFileSync(path.join(root, '.heph', '.gitignore'), 'utf8')).toContain('sessions/');
    expect(fs.readdirSync(path.join(root, '.heph', 'sessions'))).toEqual(['a.json', 'b.json']); // no .tmp left
  });

  it('returns nothing for unknown sessions, and rejects path tricks in ids', () => {
    const store = new SessionStore(root);
    expect(store.load('nope')).toBeUndefined();
    expect(store.latest()).toBeUndefined();
    expect(() => store.save(session('../evil', 'x'))).toThrow(/Invalid session id/);
  });

  it('ids are sortable timestamps', () => {
    expect(SessionStore.newId(new Date('2026-11-08T14:05:09Z'))).toMatch(
      /^20261108-140509-[a-z0-9]{1,4}$/,
    );
  });

  it('the title is the first user message, without heph notes, shortened', () => {
    expect(
      sessionTitle([
        { role: 'user', content: '[Note from heph: resumed]\n\nFix   the\nlogin bug please' },
      ]),
    ).toBe('Fix the login bug please');
    expect(sessionTitle([{ role: 'user', content: 'x'.repeat(100) }])).toHaveLength(60);
  });

  it('REGRESSION: the title skips the compaction summary', () => {
    expect(
      sessionTitle([
        { role: 'user', content: '[Summary of the earlier conversation]\n- stuff' },
        { role: 'assistant', content: 'Understood.' },
        { role: 'user', content: 'Which words did you find?' },
      ]),
    ).toBe('Which words did you find?');
  });

  it('ensureGitignore adds missing entries without duplicating', () => {
    fs.mkdirSync(path.join(root, '.heph'));
    fs.writeFileSync(path.join(root, '.heph', '.gitignore'), 'logs/\n');
    ensureGitignore(path.join(root, '.heph'));
    ensureGitignore(path.join(root, '.heph'));
    expect(fs.readFileSync(path.join(root, '.heph', '.gitignore'), 'utf8')).toBe(
      'logs/\nsessions/\n',
    );
  });
});

describe('Conversation history/restore', () => {
  it('restores a saved history behind the CURRENT system prompt', () => {
    const c = new Conversation('NEW SYSTEM PROMPT');
    c.restore([
      { role: 'system', content: 'old system prompt' },
      { role: 'user', content: 'hi' },
    ]);
    expect(c.messages()).toEqual([
      { role: 'system', content: 'NEW SYSTEM PROMPT' },
      { role: 'user', content: 'hi' },
    ]);
    expect(c.history()).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
