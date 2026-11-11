import chalk from 'chalk';

/** "HEPH" in block letters (ANSI Shadow style). 32 columns wide. */
const LOGO = [
  '██╗  ██╗███████╗██████╗ ██╗  ██╗',
  '██║  ██║██╔════╝██╔══██╗██║  ██║',
  '███████║█████╗  ██████╔╝███████║',
  '██╔══██║██╔══╝  ██╔═══╝ ██╔══██║',
  '██║  ██║███████╗██║     ██║  ██║',
  '╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝',
];

/** Forge colours: a gradient from ember yellow to molten red, top to bottom. */
const GRADIENT = ['#ffd166', '#ffb347', '#ff8c42', '#ff6b35', '#f04e23', '#c43c1a'];

/**
 * The big bold heading shown at startup. Falls back to a single line when the
 * terminal is too narrow (or not a terminal), so it never wraps into a mess.
 */
export function renderLogo(columns: number | undefined, version: string): string {
  if (!columns || columns < LOGO[0]!.length + 4) {
    return `${chalk.bold.hex('#ff8c42')('🔨 HEPH')} ${chalk.dim(`v${version}`)}`;
  }
  const art = LOGO.map((line, i) => `  ${chalk.bold.hex(GRADIENT[i] ?? '#ff8c42')(line)}`);
  const tagline = `  ${chalk.dim('the careful coding agent')}  ${chalk.dim(`v${version}`)}`;
  return [...art, tagline].join('\n');
}
