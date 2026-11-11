import chalk from 'chalk';
import { Spinner, type SpinnerLike } from './Spinner.js';

/**
 * heph's compact "working" animation, ONE line, 8 columns:
 *
 *     🔨   ▃      raise
 *      🔨  ▃      swing
 *       🔨✦▃      STRIKE (spark)
 *       🔨✧▃      sparks
 *      🔨 ·▃      bounce back
 *
 * 🔨 is 2 columns wide in modern terminals. Every frame is exactly 8 columns,
 * so the label next to it never jitters.
 */
const RAW_FRAMES = [
  '  🔨   ▃',
  '   🔨  ▃',
  '    🔨 ▃',
  '    🔨✦▃',
  '    🔨✧▃',
  '   🔨 ·▃',
  '  🔨   ▃',
] as const;

const anvil = chalk.hex('#7d8796');
const spark = chalk.hex('#ffb347').bold;

function paint(frame: string): string {
  let out = '';
  for (const ch of frame) {
    // iterating a string with for…of keeps the emoji whole (no broken surrogate pairs)
    if (ch === '▃') out += anvil(ch);
    else if (ch === '✦' || ch === '✧' || ch === '·') out += spark(ch);
    else out += ch;
  }
  return out;
}

/** Plain frames, for tests (every one must be the same display width). */
export const HAMMER_RAW_FRAMES: readonly string[] = RAW_FRAMES;
export const HAMMER_FRAMES: readonly string[] = RAW_FRAMES.map(paint);

export function createHammerSpinner(
  write: (text: string) => void,
  style: (t: string) => string = (t) => t,
): SpinnerLike {
  return new Spinner(write, { enabled: true, style, frames: HAMMER_FRAMES, intervalMs: 120 });
}
