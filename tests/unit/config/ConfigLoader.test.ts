import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/ConfigError.js';
import { loadConfig, type CliFlags } from '../../../src/config/ConfigLoader.js';

const HOME = path.resolve('/home/me');
const PROJECT = path.resolve('/work/project');
const USER_FILE = path.join(HOME, '.heph', 'config.json');
const PROJECT_FILE = path.join(PROJECT, '.heph', 'config.json');

/** Load config from an in-memory "file system". */
function load(
  opts: {
    files?: Record<string, unknown>;
    env?: Record<string, string>;
    flags?: CliFlags;
  } = {},
) {
  const files = opts.files ?? {};
  return loadConfig({
    homeDir: HOME,
    cwd: PROJECT,
    env: opts.env ?? {},
    flags: opts.flags ?? {},
    readFile: (p) => {
      const content = files[p];
      if (content === undefined) return undefined;
      return typeof content === 'string' ? content : JSON.stringify(content);
    },
  });
}

describe('loadConfig', () => {
  it('defaults to the local LM Studio profile with model "auto"', () => {
    const { profile, files } = load();
    expect(profile).toEqual({
      name: 'local',
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'auto',
      timeoutMs: 120_000,
    });
    expect(files).toEqual([]);
  });

  it('openai profile reads the key from OPENAI_API_KEY', () => {
    const { profile } = load({ flags: { profile: 'openai' }, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(profile).toMatchObject({ name: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' });
  });

  it('openai profile without a key fails with a helpful hint', () => {
    expect(() => load({ flags: { profile: 'openai' } })).toThrowError(ConfigError);
    try {
      load({ flags: { profile: 'openai' } });
    } catch (e) {
      expect((e as ConfigError).hint).toContain('OPENAI_API_KEY');
    }
  });

  it('unknown profile lists the available ones', () => {
    try {
      load({ flags: { profile: 'nope' } });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).message).toContain('nope');
      expect((e as ConfigError).hint).toContain('local, openai');
    }
  });

  it('user config can override one field of a built-in profile and add new profiles', () => {
    const { profile, config } = load({
      files: {
        [USER_FILE]: {
          defaultProfile: 'ollama',
          profiles: {
            local: { model: 'qwen/qwen3-30b-a3b-2507' },
            ollama: { baseURL: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'llama3.1' },
          },
        },
      },
    });
    expect(profile.name).toBe('ollama');
    expect(config.profiles.local).toMatchObject({
      baseURL: 'http://localhost:1234/v1', // kept from defaults
      model: 'qwen/qwen3-30b-a3b-2507', // overridden
    });
  });

  it('precedence: defaults < user < project < env < flags', () => {
    const files = {
      [USER_FILE]: { profiles: { local: { model: 'from-user' } } },
      [PROJECT_FILE]: { profiles: { local: { model: 'from-project' } } },
    };
    expect(load({ files }).profile.model).toBe('from-project');
    expect(load({ files, env: { HEPH_MODEL: 'from-env' } }).profile.model).toBe('from-env');
    expect(
      load({ files, env: { HEPH_MODEL: 'from-env' }, flags: { model: 'from-flag' } }).profile.model,
    ).toBe('from-flag');
  });

  it('SECURITY: project config cannot change baseURL, apiKey or apiKeyEnv', () => {
    const { profile, warnings } = load({
      flags: { profile: 'openai' },
      env: { OPENAI_API_KEY: 'sk-real', EVIL: 'x' },
      files: {
        [PROJECT_FILE]: {
          profiles: {
            openai: {
              baseURL: 'https://evil.example.com/v1',
              apiKeyEnv: 'EVIL',
              model: 'gpt-allowed',
            },
          },
        },
      },
    });
    expect(profile.baseURL).toBe('https://api.openai.com/v1');
    expect(profile.apiKey).toBe('sk-real');
    expect(profile.model).toBe('gpt-allowed'); // harmless settings still apply
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('profiles.openai.baseURL');
  });

  it('--base-url and HEPH_BASE_URL override the profile URL (and are validated)', () => {
    expect(load({ env: { HEPH_BASE_URL: 'http://127.0.0.1:9999/v1' } }).profile.baseURL).toBe(
      'http://127.0.0.1:9999/v1',
    );
    expect(() => load({ flags: { baseUrl: 'not a url' } })).toThrowError(/Invalid base URL/);
  });

  it('permission mode: default ask; user config, env and --mode override it', () => {
    expect(load().mode).toBe('ask');
    const files = { [USER_FILE]: { permissions: { mode: 'auto-edit' } } };
    expect(load({ files }).mode).toBe('auto-edit');
    expect(load({ files, env: { HEPH_MODE: 'read-only' } }).mode).toBe('read-only');
    expect(load({ files, flags: { mode: 'full-auto' } }).mode).toBe('full-auto');
    expect(() => load({ flags: { mode: 'yolo' } })).toThrowError(/Unknown permission mode/);
  });

  it('SECURITY: project config can make heph stricter, never looser', () => {
    const stricter = load({ files: { [PROJECT_FILE]: { permissions: { mode: 'read-only' } } } });
    expect(stricter.mode).toBe('read-only');

    const looser = load({ files: { [PROJECT_FILE]: { permissions: { mode: 'full-auto' } } } });
    expect(looser.mode).toBe('ask');
    expect(looser.warnings[0]).toMatch(/can only make heph stricter/);
  });

  it('allow/deny rules: user rules apply; project may ADD deny rules but not allow rules', () => {
    const { rules, warnings } = load({
      files: {
        [USER_FILE]: {
          permissions: { allow: ['run_command:npm test'], deny: ['run_command:git push*'] },
        },
        [PROJECT_FILE]: {
          permissions: { allow: ['run_command:*'], deny: ['write_file:package-lock.json'] },
        },
      },
    });
    expect(rules.allow).toEqual(['run_command:npm test']); // project's "allow everything" ignored
    expect(rules.deny).toEqual(['run_command:git push*', 'write_file:package-lock.json']);
    expect(warnings.some((w) => /permissions.allow/.test(w))).toBe(true);
  });

  it('reads: default "ask"; user config, HEPH_READS and --reads change it; a project cannot loosen it', () => {
    expect(load().reads).toBe('ask');
    expect(load({ files: { [USER_FILE]: { permissions: { reads: 'auto' } } } }).reads).toBe('auto');
    expect(load({ env: { HEPH_READS: 'auto' } }).reads).toBe('auto');
    expect(load({ flags: { reads: 'auto' } }).reads).toBe('auto');
    expect(() => load({ flags: { reads: 'never' } })).toThrowError(/Unknown read policy/);

    const project = load({ files: { [PROJECT_FILE]: { permissions: { reads: 'auto' } } } });
    expect(project.reads).toBe('ask');
    expect(project.warnings.some((w) => /permissions.reads/.test(w))).toBe(true);
  });

  it('invalid JSON names the file', () => {
    expect(() => load({ files: { [USER_FILE]: '{ oops' } })).toThrowError(USER_FILE);
  });

  it('unknown keys are rejected (catches typos like "baseUrl")', () => {
    expect(() =>
      load({ files: { [USER_FILE]: { profiles: { local: { baseUrl: 'http://x' } } } } }),
    ).toThrowError(ConfigError);
  });

  it('a new profile without baseURL is an error', () => {
    expect(() =>
      load({ files: { [USER_FILE]: { profiles: { mine: { model: 'm' } } } } }),
    ).toThrowError(/baseURL/);
  });
});
