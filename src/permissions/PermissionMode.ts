/**
 * How much heph may do without asking.
 *
 * | mode       | read | write (edit files)      | execute (M4: shell) |
 * |------------|------|-------------------------|---------------------|
 * | read-only  | auto | denied                  | denied              |
 * | ask        | auto | ASK every time          | ask                 |
 * | auto-edit  | auto | auto (diff still shown) | ask                 |
 * | full-auto  | auto | auto                    | auto (M4)           |
 */
export const PERMISSION_MODES = ['read-only', 'ask', 'auto-edit', 'full-auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_MODE: PermissionMode = 'ask';

export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  'read-only': 'can only read; every change is refused',
  ask: 'asks you before every change (default)',
  'auto-edit': 'edits files without asking (diffs are still shown)',
  'full-auto': 'does everything without asking (use only in throw-away folders)',
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Higher = stricter. Used so a project config can only make heph MORE careful. */
export function strictness(mode: PermissionMode): number {
  return PERMISSION_MODES.length - 1 - PERMISSION_MODES.indexOf(mode);
}

/**
 * Whether reading files needs approval (in the `ask` and `read-only` modes).
 *   ask  → the first read asks you; answer "a" to allow all reads for the session
 *   auto → reads inside the workspace are automatic (secrets are still blocked)
 * In `auto-edit` and `full-auto`, reads are always automatic.
 */
export const READ_POLICIES = ['ask', 'auto'] as const;
export type ReadPolicy = (typeof READ_POLICIES)[number];
export const DEFAULT_READ_POLICY: ReadPolicy = 'ask';

export function isReadPolicy(value: unknown): value is ReadPolicy {
  return typeof value === 'string' && (READ_POLICIES as readonly string[]).includes(value);
}
