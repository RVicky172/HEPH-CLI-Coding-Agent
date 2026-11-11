import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';

/**
 * All colours and layout helpers in one place.
 *
 *   ❯ you                  slate band     your message
 *   ● heph ─────── model   orange badge   start of the agent's turn
 *   ✓ read_file …  2ms     dark band      what the agent DID (details right-aligned)
 *   ▎ answer               orange bar     what the agent SAYS (Markdown)
 *   + / −                  green / red    diff lines
 *
 * Every background sets its own foreground too, so it reads well on both dark
 * and light terminal themes. Without colour support (pipes, NO_COLOR) all of
 * this degrades to plain text.
 */
export const colors = {
  accent: '#ff8c42',
  accentSoft: '#ffb37a',
  userBg: '#2f3a56',
  userFg: '#f1f5ff',
  userBadgeBg: '#5b7bd5',
  activityBg: '#1d2230',
  activityFg: '#c9d1e3',
  approvalBg: '#4a3410',
  dangerBg: '#5a1a1a',
  addBg: '#123d22',
  addFg: '#8ff0a4',
  removeBg: '#4a1717',
  removeFg: '#ffb3b3',
  contextFg: '#8a93a6',
  border: '#4b5367',
  suggestBg: '#232a3b',
  suggestSelectedBg: '#3a4566',
} as const;

export interface Theme {
  /** Draw backgrounds, rules and aligned columns? (false in tests, pipes and no-colour terminals) */
  readonly backgrounds: boolean;
  /** Current terminal width in columns. */
  readonly width: () => number;
}

export const plainTheme: Theme = { backgrounds: false, width: () => 80 };

/** Display width: ANSI codes take no space; emoji and CJK take two columns. */
export function visibleLength(text: string): number {
  let width = 0;
  for (const ch of stripVTControlCharacters(text)) {
    const code = ch.codePointAt(0) ?? 0;
    width +=
      code >= 0x1f000 ||
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60)
        ? 2
        : 1;
  }
  return width;
}

/**
 * Paint one line with a background across the full terminal width.
 * Wrapped lines are padded to a multiple of the width so the band has no gaps.
 */
export function band(
  theme: Theme,
  text: string,
  bg: string,
  fg?: string,
  /** Columns already used on this line before `text` (e.g. a "  │ " prefix). */
  offset = 0,
): string {
  if (!theme.backgrounds) return text;
  const width = Math.max(20, theme.width()) - offset;
  const len = visibleLength(text);
  const rows = Math.max(1, Math.ceil(len / width));
  // Leave the very last column empty: some terminals wrap early when it's filled.
  const padded = text + ' '.repeat(Math.max(0, rows * width - len - 1));
  const painted = chalk.bgHex(bg)(padded);
  return fg ? chalk.hex(fg)(painted) : painted;
}

/** `left …………… right` on one line: right part flush with the right edge. */
export function spread(theme: Theme, left: string, right: string, min = 2): string {
  const gap = theme.width() - 1 - visibleLength(left) - visibleLength(right);
  return gap >= min ? `${left}${' '.repeat(gap)}${right}` : `${left}${' '.repeat(min)}${right}`;
}

/** A dim horizontal rule filling the rest of the line. */
export function rule(theme: Theme, used: number, char = '─'): string {
  return chalk.hex(colors.border)(char.repeat(Math.max(3, theme.width() - 1 - used)));
}

/** Shorten long paths in the middle: C:\Users\me\…\my-project */
export function shortenMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(4, max - 1);
  const head = Math.ceil(keep / 3);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** Cut text to a display width, adding "…". */
export function truncate(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (visibleLength(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** The "● heph" badge that starts every agent turn. */
export function agentBadge(theme: Theme): string {
  return theme.backgrounds
    ? chalk.bgHex(colors.accent).hex('#1a1a1a').bold(' ◆ heph ')
    : chalk.hex(colors.accent).bold('◆ heph');
}

/** The "you" badge on the user's message. */
export function userBadge(theme: Theme): string {
  return theme.backgrounds
    ? chalk.bgHex(colors.userBadgeBg).hex('#ffffff').bold(' you ')
    : chalk.bold('❯');
}

/** Left edge of the agent's answer. */
export function answerGutter(theme: Theme): string {
  return theme.backgrounds ? `${chalk.hex(colors.accent)('▎')} ` : '  ';
}
