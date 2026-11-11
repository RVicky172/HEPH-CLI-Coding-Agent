import chalk from 'chalk';
import { HephError } from '../core/errors/HephError.js';

/** Expected errors get a clean message + hint. Unexpected ones (bugs) get the stack. */
export function formatError(error: unknown): string {
  if (error instanceof HephError) {
    const lines = [chalk.red(`✖ ${error.message}`)];
    if (error.hint) lines.push(chalk.dim(`  ${error.hint}`));
    return lines.join('\n');
  }
  if (error instanceof Error) {
    const details = process.env.HEPH_DEBUG ? `\n${error.stack ?? ''}` : '';
    return (
      chalk.red(`✖ Unexpected error: ${error.message}`) +
      chalk.dim(details || '\n  (set HEPH_DEBUG=1 for details)')
    );
  }
  return chalk.red(`✖ ${String(error)}`);
}
