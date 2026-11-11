import { describe, expect, it } from 'vitest';
import { IgnoreRules } from '../../../src/workspace/IgnoreRules.js';

describe('IgnoreRules', () => {
  const rules = new IgnoreRules('*.log\nsecret-notes/\n');

  it('always hides node_modules, .git and build output', () => {
    expect(rules.isIgnored('node_modules', true)).toBe(true);
    expect(rules.isIgnored('packages/a/node_modules', true)).toBe(true);
    expect(rules.isIgnored('.git', true)).toBe(true);
    expect(rules.isIgnored('dist', true)).toBe(true);
    expect(rules.isIgnored('src', true)).toBe(false);
  });

  it('respects .gitignore patterns', () => {
    expect(rules.isIgnored('debug.log')).toBe(true);
    expect(rules.isIgnored('secret-notes', true)).toBe(true);
    expect(rules.isIgnored('src/app.ts')).toBe(false);
  });

  it('marks secret files as sensitive (never readable)', () => {
    for (const p of [
      '.env',
      '.env.local',
      'config/.env.production',
      'certs/server.pem',
      'id_rsa',
      'deploy/server.key',
      '.git/config',
      '.npmrc',
    ]) {
      expect(rules.isSensitive(p), p).toBe(true);
    }
  });

  it('allows harmless templates and normal files', () => {
    for (const p of ['.env.example', '.env.sample', 'src/env.ts', 'README.md', 'keys.ts']) {
      expect(rules.isSensitive(p), p).toBe(false);
    }
  });
});
