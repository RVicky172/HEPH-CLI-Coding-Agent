import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  createHammerSpinner,
  HAMMER_FRAMES,
  HAMMER_RAW_FRAMES,
} from '../../../src/ui/render/HammerSpinner.js';
import { band, spread, truncate, visibleLength } from '../../../src/ui/render/theme.js';

describe('hammer spinner (one line)', () => {
  it('every frame has the same display width (8 columns), so the label never jitters', () => {
    for (const frame of HAMMER_RAW_FRAMES) expect(visibleLength(frame)).toBe(8);
    for (const frame of HAMMER_FRAMES) expect(visibleLength(frame)).toBe(8);
  });

  it('strikes the anvil with a spark, and keeps the emoji intact', () => {
    expect(HAMMER_RAW_FRAMES.some((f) => f.includes('🔨✦▃'))).toBe(true);
    for (const f of HAMMER_FRAMES) expect(stripVTControlCharacters(f)).toContain('🔨');
  });

  it('stays on ONE line and erases itself on stop', () => {
    vi.useFakeTimers();
    let out = '';
    const spinner = createHammerSpinner((t: string) => (out += t));
    spinner.start('thinking…');
    vi.advanceTimersByTime(500);
    expect(out).not.toContain('\n');
    expect(stripVTControlCharacters(out)).toContain('thinking…');
    out = '';
    spinner.stop();
    expect(out).toBe('\r\x1b[2K');
    vi.useRealTimers();
  });
});

describe('theme helpers', () => {
  const theme = { backgrounds: true, width: () => 30 };

  it('band pads to the terminal width minus one column (and minus an offset)', () => {
    expect(visibleLength(band(theme, 'hi', '#000000'))).toBe(29);
    expect(visibleLength(band(theme, 'hi', '#000000', undefined, 4))).toBe(25);
    expect(band({ backgrounds: false, width: () => 30 }, 'hi', '#000000')).toBe('hi');
  });

  it('spread pushes the right part to the right edge', () => {
    const line = spread(theme, 'left', 'right');
    expect(visibleLength(line)).toBe(29);
    expect(line.endsWith('right')).toBe(true);
  });

  it('visibleLength counts emoji as 2 columns; truncate respects it', () => {
    expect(visibleLength('🔨a')).toBe(3);
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});
