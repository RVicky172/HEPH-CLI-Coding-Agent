import chalk from 'chalk';

/**
 * heph's visual language: every tool and every process has its OWN icon,
 * colour and verbs, so you can tell at a glance what is happening.
 *
 *   ▤ Listed   ◧ Read   ✱ Found   ⌕ Searched      ← looking (cool blues and teals)
 *   ✎ Edited   ✚ Wrote                            ← changing (warm amber and orange)
 *   ❯ Ran                                         ← executing (rose)
 *   ✻ reasoning   ⧉ compacted   ✂ trimmed         ← the agent's own processes
 *   ✔ done   ✘ failed   ⊘ denied by you           ← outcome, always at the row's end
 *
 * All glyphs are single-width Unicode symbols (no emoji), so columns stay aligned.
 * Adding a tool = adding one entry. Unknown tools get a neutral fallback (Open/Closed).
 */
export interface ToolStyle {
  readonly icon: string;
  readonly color: string;
  /** Shown while running: "Reading". */
  readonly active: string;
  /** Shown when done: "Read". */
  readonly done: string;
  /** Used in approval titles: "heph wants to edit a file". */
  readonly intent: string;
}

export const TOOL_STYLES: Readonly<Record<string, ToolStyle>> = {
  list_directory: {
    icon: '▤',
    color: '#7cc8f8',
    active: 'Listing',
    done: 'Listed',
    intent: 'list a folder',
  },
  read_file: {
    icon: '◧',
    color: '#4fd1c5',
    active: 'Reading',
    done: 'Read',
    intent: 'read a file',
  },
  glob: { icon: '✱', color: '#8fb4ff', active: 'Finding', done: 'Found', intent: 'find files' },
  grep: {
    icon: '⌕',
    color: '#5ee0f0',
    active: 'Searching',
    done: 'Searched',
    intent: 'search your code',
  },
  edit_file: {
    icon: '✎',
    color: '#f5b942',
    active: 'Editing',
    done: 'Edited',
    intent: 'edit a file',
  },
  write_file: {
    icon: '✚',
    color: '#ff9a52',
    active: 'Writing',
    done: 'Wrote',
    intent: 'write a file',
  },
  run_command: {
    icon: '❯',
    color: '#ff7aa2',
    active: 'Running',
    done: 'Ran',
    intent: 'run a command',
  },
};

const FALLBACK: ToolStyle = {
  icon: '•',
  color: '#9aa4b8',
  active: 'Using',
  done: 'Used',
  intent: 'use a tool',
};

export function toolStyle(name: string): ToolStyle {
  return TOOL_STYLES[name] ?? { ...FALLBACK, active: `Using ${name}`, done: name };
}

/** The agent's own processes and outcomes. */
export const MARKS = {
  reasoning: { icon: '✻', color: '#ffb37a' },
  compacted: { icon: '⧉', color: '#d9b96b' },
  trimmed: { icon: '✂', color: '#8d97ab' },
  warning: { icon: '▲', color: '#f6c945' },
  interrupted: { icon: '■', color: '#f6a35b' },
  ok: { icon: '✔', color: '#5fdc8a' },
  failed: { icon: '✘', color: '#ff6b6b' },
  denied: { icon: '⊘', color: '#ff8f6b' },
  approval: { icon: '⚑', color: '#f5b942' },
  time: { icon: '◷', color: '#8d97ab' },
  steps: { icon: '↻', color: '#8d97ab' },
  tokens: { icon: '⇅', color: '#8d97ab' },
  context: { icon: '◔', color: '#8d97ab' },
} as const;

export type MarkName = keyof typeof MARKS;

/** A mark's icon in its own colour. */
export function mark(name: MarkName): string {
  const m = MARKS[name];
  return chalk.hex(m.color)(m.icon);
}

/** Slash command icons, shown in suggestions and /help. */
export const COMMAND_ICONS: Readonly<Record<string, string>> = {
  help: '?',
  mode: '◐',
  undo: '↶',
  context: '◔',
  compact: '⧉',
  clear: '⌫',
  model: '◈',
  exit: '⎋',
};

export function commandIcon(name: string): string {
  return COMMAND_ICONS[name] ?? '/';
}
