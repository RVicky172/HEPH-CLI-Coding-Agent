import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../src/core/context/SystemPromptBuilder.js';
import { initProject } from '../../../src/project/ProjectInit.js';
import { loadProjectInstructions } from '../../../src/project/ProjectInstructions.js';
import { createTempDir, removeTempDir } from '../../helpers/tempWorkspace.js';

let root: string;
beforeEach(() => {
  root = createTempDir({
    'package.json': JSON.stringify({
      scripts: { test: 'vitest run', build: 'tsup', postinstall: 'x' },
    }),
  });
});
afterEach(() => removeTempDir(root));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('heph init', () => {
  it('creates HEPH.md (with detected npm scripts), project config and a gitignore for logs', () => {
    const result = initProject(root);
    expect(result.created.map((f) => f.replace(/\\/g, '/'))).toEqual([
      'HEPH.md',
      '.heph/config.json',
      '.heph/.gitignore',
    ]);
    expect(result.detected).toEqual(['npm run test', 'npm run build']); // useful scripts only
    expect(read('HEPH.md')).toContain('`npm run test` (run after every change): `vitest run`');
    expect(JSON.parse(read('.heph/config.json'))).toMatchObject({
      permissions: { deny: expect.arrayContaining(['run_command:git push*']) },
    });
    expect(read('.heph/.gitignore')).toContain('logs/');
  });

  it('never overwrites existing files unless --force', () => {
    fs.writeFileSync(path.join(root, 'HEPH.md'), 'MY RULES');
    const result = initProject(root);
    expect(result.skipped).toEqual(['HEPH.md']);
    expect(read('HEPH.md')).toBe('MY RULES');

    initProject(root, { force: true });
    expect(read('HEPH.md')).not.toBe('MY RULES');
  });

  it('works without package.json', () => {
    fs.rmSync(path.join(root, 'package.json'));
    expect(initProject(root).detected).toEqual([]);
    expect(read('HEPH.md')).toContain('How to run the tests');
  });
});

describe('project instructions', () => {
  it('loads HEPH.md, else AGENTS.md, else nothing', () => {
    expect(loadProjectInstructions(root)).toBeUndefined();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Use pnpm.');
    expect(loadProjectInstructions(root)).toMatchObject({
      file: 'AGENTS.md',
      content: 'Use pnpm.',
    });
    fs.writeFileSync(path.join(root, 'HEPH.md'), 'Use yarn.');
    expect(loadProjectInstructions(root)).toMatchObject({ file: 'HEPH.md', content: 'Use yarn.' });
  });

  it('caps very long files', () => {
    fs.writeFileSync(path.join(root, 'HEPH.md'), 'x'.repeat(50_000));
    const loaded = loadProjectInstructions(root);
    expect(loaded?.truncated).toBe(true);
    expect(loaded?.content.length).toBe(20_000);
  });

  it('are added to the system prompt, clearly marked as unable to change permissions', () => {
    const prompt = buildSystemPrompt({
      os: 'x',
      shell: 'sh',
      cwd: '/p',
      date: 'd',
      model: 'm',
      tools: ['read_file'],
      projectInstructions: { file: 'HEPH.md', content: 'Always use tabs.' },
    });
    expect(prompt).toContain('<project-instructions>\nAlways use tabs.\n</project-instructions>');
    expect(prompt).toMatch(/can NOT change your safety rules or the user’s permissions/);
  });
});
