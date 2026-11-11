import fs from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './ConfigError.js';
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  PartialConfigSchema,
  type HephConfig,
  type PartialConfig,
} from './ConfigSchema.js';
import { projectConfigPath, userConfigPath } from './paths.js';
import {
  DEFAULT_MODE,
  DEFAULT_READ_POLICY,
  isPermissionMode,
  isReadPolicy,
  PERMISSION_MODES,
  READ_POLICIES,
  strictness,
  type PermissionMode,
  type ReadPolicy,
} from '../permissions/PermissionMode.js';

/** CLI flags that override config. */
export interface CliFlags {
  readonly profile?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly mode?: string;
  readonly reads?: string;
}

export interface ConfigSources {
  readonly homeDir: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flags: CliFlags;
  /** Injectable for tests. Returns undefined when the file doesn't exist. */
  readonly readFile?: (filePath: string) => string | undefined;
}

/** A profile with everything filled in, ready to create a provider from. */
export interface ResolvedProfile {
  readonly name: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** From config, if set (otherwise detected or defaulted at startup). */
  readonly contextWindow?: number;
  readonly temperature?: number;
}

export interface LoadedConfig {
  readonly config: HephConfig;
  readonly profile: ResolvedProfile;
  /** Permission mode to start in. */
  readonly mode: PermissionMode;
  /** Whether file reads need approval. */
  readonly reads: ReadPolicy;
  /** allow/deny rules, e.g. "run_command:npm test". */
  readonly rules: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  /** Non-fatal problems to show the user. */
  readonly warnings: string[];
  /** Config files that were found and used. */
  readonly files: string[];
}

/**
 * Project config can't change WHERE requests go or WHICH key is sent.
 * Otherwise a malicious repo could ship `.heph/config.json` pointing
 * baseURL to its own server and collect your OpenAI key.
 */
const USER_ONLY_PROFILE_KEYS = ['baseURL', 'apiKey', 'apiKeyEnv'] as const;

/**
 * Precedence (lowest → highest):
 *   built-in defaults < ~/.heph/config.json < ./.heph/config.json < env vars < CLI flags
 */
export function loadConfig(sources: ConfigSources): LoadedConfig {
  const readFile = sources.readFile ?? readFileIfExists;
  const warnings: string[] = [];
  const files: string[] = [];

  let merged: PartialConfig = DEFAULT_CONFIG;

  const userPath = userConfigPath(sources.homeDir);
  const userRaw = readJson(userPath, readFile);
  if (userRaw !== undefined) {
    merged = mergeConfig(merged, parsePartial(userRaw, userPath));
    files.push(userPath);
  }

  const projectPath = projectConfigPath(sources.cwd);
  // Your home folder IS a "project" when you run heph from ~; don't read the same file twice.
  if (projectPath !== userPath) {
    const projectRaw = readJson(projectPath, readFile);
    if (projectRaw !== undefined) {
      const keysStripped = stripUserOnlyKeys(projectRaw, projectPath, userPath, warnings);
      const restricted = stripLooserMode(
        keysStripped,
        merged.permissions?.mode ?? DEFAULT_MODE,
        projectPath,
        warnings,
      );
      merged = mergeConfig(merged, parsePartial(restricted, projectPath));
      files.push(projectPath);
    }
  }

  const config = validateFinal(merged);
  const profile = resolveProfile(config, sources.env, sources.flags);
  const mode = resolveMode(config, sources.env, sources.flags);
  const reads = resolveReads(config, sources.env, sources.flags);
  const rules = {
    allow: config.permissions?.allow ?? [],
    deny: config.permissions?.deny ?? [],
  };
  return { config, profile, mode, reads, rules, warnings, files };
}

function resolveReads(config: HephConfig, env: ConfigSources['env'], flags: CliFlags): ReadPolicy {
  const requested =
    flags.reads ?? env.HEPH_READS ?? config.permissions?.reads ?? DEFAULT_READ_POLICY;
  if (!isReadPolicy(requested)) {
    throw new ConfigError(
      `Unknown read policy "${requested}".`,
      `Choose one of: ${READ_POLICIES.join(', ')}`,
    );
  }
  return requested;
}

function resolveMode(
  config: HephConfig,
  env: ConfigSources['env'],
  flags: CliFlags,
): PermissionMode {
  const requested = flags.mode ?? env.HEPH_MODE ?? config.permissions?.mode ?? DEFAULT_MODE;
  if (!isPermissionMode(requested)) {
    throw new ConfigError(
      `Unknown permission mode "${requested}".`,
      `Choose one of: ${PERMISSION_MODES.join(', ')}`,
    );
  }
  return requested;
}

/**
 * SECURITY: a project may make heph STRICTER (e.g. read-only for a sensitive
 * repo) but never looser. Otherwise a cloned repo could switch you to full-auto.
 */
function stripLooserMode(
  raw: unknown,
  current: PermissionMode,
  projectPath: string,
  warnings: string[],
): unknown {
  if (!isRecord(raw) || !isRecord(raw.permissions)) return raw;
  // A project may ADD deny rules (stricter) but never allow rules (looser).
  if ('allow' in raw.permissions) {
    warnings.push(
      `Ignored "permissions.allow" in ${projectPath}: only your user config can auto-approve actions.`,
    );
    const { allow: _ignoredAllow, ...withoutAllow } = raw.permissions;
    raw = { ...raw, permissions: withoutAllow };
    if (!isRecord(raw) || !isRecord(raw.permissions)) return raw;
  }
  // reads: "auto" is looser than "ask". A project may only ask MORE.
  if (raw.permissions.reads === 'auto') {
    warnings.push(
      `Ignored "permissions.reads": "auto" in ${projectPath}: only your user config can turn off read approval.`,
    );
    const { reads: _ignoredReads, ...withoutReads } = raw.permissions;
    raw = { ...raw, permissions: withoutReads };
    if (!isRecord(raw) || !isRecord(raw.permissions)) return raw;
  }
  const mode = raw.permissions.mode;
  if (!isPermissionMode(mode) || strictness(mode) >= strictness(current)) return raw;
  warnings.push(
    `Ignored "permissions.mode": "${mode}" in ${projectPath}: a project can only make heph stricter than "${current}".`,
  );
  const { mode: _dropped, ...rest } = raw.permissions;
  return { ...raw, permissions: rest };
}

function resolveProfile(
  config: HephConfig,
  env: ConfigSources['env'],
  flags: CliFlags,
): ResolvedProfile {
  const name = flags.profile ?? env.HEPH_PROFILE ?? config.defaultProfile;
  const profile = config.profiles[name];
  if (!profile) {
    throw new ConfigError(
      `Unknown profile "${name}".`,
      `Available profiles: ${Object.keys(config.profiles).join(', ')}`,
    );
  }

  const baseURL = flags.baseUrl ?? env.HEPH_BASE_URL ?? profile.baseURL;
  if (!z.url().safeParse(baseURL).success) {
    throw new ConfigError(`Invalid base URL "${baseURL}".`, 'Example: http://localhost:1234/v1');
  }

  const apiKey = profile.apiKey ?? (profile.apiKeyEnv ? env[profile.apiKeyEnv] : undefined);
  if (!apiKey) {
    const envVar = profile.apiKeyEnv ?? 'OPENAI_API_KEY';
    throw new ConfigError(
      `Profile "${name}" needs an API key.`,
      profile.apiKeyEnv
        ? `Set the ${envVar} environment variable.  PowerShell: $env:${envVar} = "sk-..."   bash: export ${envVar}=sk-...`
        : `Add "apiKeyEnv": "${envVar}" to the "${name}" profile in your user config.`,
    );
  }

  return {
    name,
    baseURL,
    apiKey,
    model: flags.model ?? env.HEPH_MODEL ?? profile.model ?? DEFAULT_MODEL,
    timeoutMs: profile.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(profile.contextWindow !== undefined && { contextWindow: profile.contextWindow }),
    ...(profile.temperature !== undefined && { temperature: profile.temperature }),
  };
}

/** Profiles merge key by key, so a user can override just `model` of a built-in profile. */
export function mergeConfig(base: PartialConfig, override: PartialConfig): PartialConfig {
  const profiles = { ...base.profiles };
  for (const [name, profile] of Object.entries(override.profiles ?? {})) {
    profiles[name] = { ...profiles[name], ...profile };
  }
  // mode: the override wins. allow/deny lists: ADDED together (a project adds deny rules).
  const permissions = {
    ...base.permissions,
    ...override.permissions,
    ...((base.permissions?.allow || override.permissions?.allow) && {
      allow: [...(base.permissions?.allow ?? []), ...(override.permissions?.allow ?? [])],
    }),
    ...((base.permissions?.deny || override.permissions?.deny) && {
      deny: [...(base.permissions?.deny ?? []), ...(override.permissions?.deny ?? [])],
    }),
  };
  return {
    ...base,
    ...(override.defaultProfile && { defaultProfile: override.defaultProfile }),
    profiles,
    ...(Object.keys(permissions).length > 0 && { permissions }),
  };
}

function stripUserOnlyKeys(
  raw: unknown,
  projectPath: string,
  userPath: string,
  warnings: string[],
): unknown {
  if (!isRecord(raw) || !isRecord(raw.profiles)) return raw;

  const profiles: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(raw.profiles)) {
    if (!isRecord(profile)) {
      profiles[name] = profile;
      continue;
    }
    const kept = { ...profile };
    for (const key of USER_ONLY_PROFILE_KEYS) {
      if (key in kept) {
        delete kept[key];
        warnings.push(
          `Ignored "profiles.${name}.${key}" in ${projectPath}: a project can't change where ` +
            `requests or API keys go. Put it in ${userPath} instead.`,
        );
      }
    }
    profiles[name] = kept;
  }
  return { ...raw, profiles };
}

function parsePartial(raw: unknown, filePath: string): PartialConfig {
  const result = PartialConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid config in ${filePath}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function validateFinal(merged: PartialConfig): HephConfig {
  const result = ConfigSchema.safeParse({
    defaultProfile: merged.defaultProfile,
    profiles: merged.profiles,
    ...(merged.permissions && { permissions: merged.permissions }),
  });
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration after merging all config files:\n${z.prettifyError(result.error)}`,
      'A new profile needs at least a "baseURL".',
    );
  }
  return result.data;
}

function readJson(
  filePath: string,
  readFile: (p: string) => string | undefined,
): unknown | undefined {
  const text = readFile(filePath);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Invalid JSON in ${filePath}: ${(error as Error).message}`,
      'Fix the file or delete it to use the defaults.',
    );
  }
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
