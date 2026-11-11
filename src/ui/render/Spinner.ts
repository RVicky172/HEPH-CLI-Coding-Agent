const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface SpinnerLike {
  start(text: string): void;
  stop(): void;
}

export interface SpinnerOptions {
  readonly enabled: boolean;
  /** Style for the label text. */
  readonly style?: (text: string) => string;
  /** Animation frames (already coloured). Default: a braille dot spinner. */
  readonly frames?: readonly string[];
  readonly intervalMs?: number;
}

/**
 * A one-line spinner ("⠹ thinking…" or the hammer "  🔨✦▃ thinking…").
 * It redraws its own line with \r and erases it on stop, so the next output
 * starts on a clean line. Disabled (no-op) when output isn't a terminal.
 */
export class Spinner implements SpinnerLike {
  readonly #write: (text: string) => void;
  readonly #enabled: boolean;
  readonly #style: (text: string) => string;
  readonly #frames: readonly string[];
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #frame = 0;
  #text = '';

  constructor(write: (text: string) => void, options: SpinnerOptions) {
    this.#write = write;
    this.#enabled = options.enabled;
    this.#style = options.style ?? ((t) => t);
    this.#frames = options.frames ?? BRAILLE;
    this.#intervalMs = options.intervalMs ?? 80;
  }

  start(text: string): void {
    if (!this.#enabled) return;
    this.#text = text;
    if (this.#timer) return; // already spinning: only the text changes
    this.#draw();
    this.#timer = setInterval(() => this.#draw(), this.#intervalMs);
    this.#timer.unref?.(); // never keep the process alive just for the spinner
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#write('\r\x1b[2K'); // carriage return + erase line
  }

  #draw(): void {
    const frame = this.#frames[this.#frame++ % this.#frames.length] ?? '';
    this.#write(`\r\x1b[2K${frame} ${this.#style(this.#text)}`);
  }
}
