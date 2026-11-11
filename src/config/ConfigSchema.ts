import { z } from 'zod';
import { PERMISSION_MODES, READ_POLICIES } from '../permissions/PermissionMode.js';

/** What heph may do without asking. See permissions/PermissionMode.ts. */
export const PermissionsSchema = z
  .object({
    mode: z.enum(PERMISSION_MODES).optional(),
    /** "ask": the first file read asks you (answer "a" for the whole session). "auto": never ask for reads. */
    reads: z.enum(READ_POLICIES).optional(),
    /** Auto-approve matching actions, e.g. "run_command:npm test". */
    allow: z.array(z.string().min(1)).optional(),
    /** Always refuse matching actions, e.g. "run_command:git push*". */
    deny: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * One LLM endpoint + model. No defaults inside the schema on purpose:
 * partial configs from different files are merged first, and defaults are
 * applied once at the end (see ConfigLoader.resolveProfile).
 */
export const ProfileSchema = z
  .object({
    baseURL: z.url(),
    /** Literal key. Fine for LM Studio ("lm-studio"). For real keys prefer apiKeyEnv. */
    apiKey: z.string().min(1).optional(),
    /** Name of the environment variable holding the key, e.g. "OPENAI_API_KEY". */
    apiKeyEnv: z.string().min(1).optional(),
    /** Model id, or "auto" to use the first chat model the server offers. */
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Context window in tokens. Auto-detected for LM Studio; set it for other servers. */
    contextWindow: z.number().int().min(1024).optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    defaultProfile: z.string().min(1),
    profiles: z.record(z.string(), ProfileSchema),
    permissions: PermissionsSchema.optional(),
  })
  .strict();

/** What a single config file may contain: everything optional. */
export const PartialConfigSchema = z
  .object({
    $schema: z.string().optional(),
    defaultProfile: z.string().min(1).optional(),
    profiles: z.record(z.string(), ProfileSchema.partial()).optional(),
    permissions: PermissionsSchema.optional(),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;
export type HephConfig = z.infer<typeof ConfigSchema>;
export type PartialConfig = z.infer<typeof PartialConfigSchema>;

export const DEFAULT_MODEL = 'auto';
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Built-in defaults: work out of the box with LM Studio, and with OpenAI once a key is set. */
export const DEFAULT_CONFIG: HephConfig = {
  defaultProfile: 'local',
  profiles: {
    local: {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lm-studio', // LM Studio accepts any non-empty key
      model: DEFAULT_MODEL,
    },
    openai: {
      baseURL: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      model: 'gpt-4o-mini',
    },
  },
};
