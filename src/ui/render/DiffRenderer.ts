import chalk from 'chalk';
import type { ApprovalRequest, DiffLine } from '../../permissions/ApprovalRequest.js';
import { toolStyle, type ToolStyle } from './styles.js';
import { band, colors, plainTheme, visibleLength, type Theme } from './theme.js';

const MAX_LINES = 80;

/**
 * Renders what a tool is about to do, BEFORE it happens:
 *
 *   ╭─ edit_file · src/math.ts · +3 −0                ╭─ run_command · in ./
 *   │  4 + export function multiply(…) {              │ $ npm test
 *   │  5 +   return a * b;                            │ ⚠ DANGER: deletes files   ← red band
 *   ╰─                                                ╰─
 *
 * With backgrounds on, added lines get a green band and removed lines a red one.
 */
export function renderApprovalPreview(
  request: ApprovalRequest,
  indent = '  ',
  theme: Theme = plainTheme,
): string {
  const { preview } = request;
  // The box takes the tool's own colour: an edit box is amber, a command box rose, a read teal.
  const s = toolStyle(request.toolName);
  const paint = chalk.hex(s.color);
  const border = (t: string) => (theme.backgrounds ? paint(t) : chalk.dim(t));
  const head = (rest: string) =>
    `${indent}${border('╭─')} ${paint(s.icon)} ${paint.bold(verbFor(s))} ${rest}`;
  const prefix = `${indent}${border('│')} `;
  const bottom = (rest = '') => `${indent}${border('╰─')}${rest ? ` ${rest}` : ''}`;
  const offset = visibleLength(prefix);

  if (preview.kind === 'command') {
    const where = preview.cwd === '.' ? './' : preview.cwd;
    const out = [head(chalk.dim(`in ${where}`))];
    if (preview.purpose) out.push(`${prefix}${chalk.dim(preview.purpose)}`);
    for (const line of preview.command.split('\n')) {
      out.push(`${prefix}${paint.bold('$')} ${chalk.bold(line)}`);
    }
    for (const warning of preview.warnings) {
      out.push(
        prefix +
          band(theme, `${chalk.bold('▲ DANGER:')} ${warning}`, colors.dangerBg, '#ffd0d0', offset),
      );
    }
    out.push(bottom());
    return out.join('\n');
  }

  if (preview.kind === 'none' && request.risk === 'read') {
    return [
      head(chalk.cyan(request.label || './')),
      bottom(chalk.dim('looking only: reading changes nothing')),
    ].join('\n');
  }

  if (preview.kind !== 'diff') {
    return `${indent}${paint(s.icon)} ${chalk.bold(request.toolName)} ${chalk.cyan(request.label)}`;
  }

  const counts = `${chalk.green(`+${preview.added}`)} ${chalk.red(`−${preview.removed}`)}`;
  const newFile = preview.isNewFile ? chalk.dim(' (new file)') : '';
  const out = [head(`${chalk.cyan(preview.path)}${newFile} ${chalk.dim('·')} ${counts}`)];

  // null marks a gap between two hunks (rendered as "⋯")
  const all: (DiffLine | null)[] = preview.hunks.flatMap((h, i) =>
    i === 0 ? [...h.lines] : [null, ...h.lines],
  );
  const width = Math.max(
    1,
    ...all.map((l) => String((l && (l.newLine ?? l.oldLine)) ?? '').length),
  );

  for (const line of all.slice(0, MAX_LINES)) {
    out.push(line ? prefix + formatLine(line, width, theme, offset) : `${prefix}${chalk.dim('⋯')}`);
  }
  if (all.length > MAX_LINES) {
    out.push(`${prefix}${chalk.dim(`… ${all.length - MAX_LINES} more lines not shown`)}`);
  }
  if (all.length === 0) out.push(`${prefix}${chalk.dim('(no changes)')}`);
  out.push(bottom());
  return out.join('\n');
}

function formatLine(line: DiffLine, width: number, theme: Theme, offset: number): string {
  const num = String((line.kind === 'remove' ? line.oldLine : line.newLine) ?? '').padStart(width);
  const text = line.text.replace(/\t/g, '  ');
  switch (line.kind) {
    case 'add':
      return theme.backgrounds
        ? band(theme, `${num} + ${text}`, colors.addBg, colors.addFg, offset)
        : `${chalk.dim(num)} ${chalk.green(`+ ${text}`)}`;
    case 'remove':
      return theme.backgrounds
        ? band(theme, `${num} - ${text}`, colors.removeBg, colors.removeFg, offset)
        : `${chalk.dim(num)} ${chalk.red(`- ${text}`)}`;
    case 'context':
      return `${chalk.dim(num)} ${chalk.hex(colors.contextFg)(`  ${text}`)}`;
  }
}

/** The verb in an approval box says what WILL happen: "Edit", "Run", "Read". */
function verbFor(s: ToolStyle): string {
  return s.intent.split(' ')[0]!.replace(/^./, (c) => c.toUpperCase());
}
