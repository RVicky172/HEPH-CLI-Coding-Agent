import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/core/agent/AgentEvents.js';
import { MarkdownBlockBuffer } from '../../../src/ui/render/MarkdownBlockBuffer.js';
import { TurnRenderer } from '../../../src/ui/render/TurnRenderer.js';
import { renderApprovalPreview } from '../../../src/ui/render/DiffRenderer.js';
import { createDiffPreview } from '../../../src/tools/fs/diffPreview.js';
import { renderLogo } from '../../../src/ui/render/logo.js';

describe('renderApprovalPreview', () => {
  it('draws a boxed diff with line numbers and +/- markers', () => {
    const before = ['one', 'two', 'three', ''].join('\n');
    const after = ['one', 'TWO', 'three', 'four', ''].join('\n');
    const preview = createDiffPreview('src/a.ts', before, after);
    const text = stripVTControlCharacters(
      renderApprovalPreview({ toolName: 'edit_file', risk: 'write', label: 'src/a.ts', preview }),
    );
    expect(text).toBe(
      [
        '  ╭─ edit_file · src/a.ts · +2 −1',
        '  │ 1   one',
        '  │ 2 - two',
        '  │ 2 + TWO',
        '  │ 3   three',
        '  │ 4 + four',
        '  ╰─',
      ].join('\n'),
    );
  });
});

describe('renderLogo', () => {
  it('shows big block letters on wide terminals, one line on narrow ones', () => {
    expect(stripVTControlCharacters(renderLogo(120, '1.2.3'))).toContain(
      '██╗  ██╗███████╗██████╗ ██╗  ██╗',
    );
    expect(stripVTControlCharacters(renderLogo(20, '1.2.3'))).toBe('🔨 HEPH v1.2.3');
    expect(stripVTControlCharacters(renderLogo(undefined, '1.2.3'))).toBe('🔨 HEPH v1.2.3');
  });
});

describe('MarkdownBlockBuffer', () => {
  it('releases a paragraph only when it is complete', () => {
    const b = new MarkdownBlockBuffer();
    expect(b.push('Hello **wor')).toEqual([]);
    expect(b.push('ld**.\n')).toEqual([]);
    expect(b.push('\nNext')).toEqual(['Hello **world**.']);
    expect(b.flush()).toBe('Next');
  });

  it('never splits a code block on its blank lines', () => {
    const b = new MarkdownBlockBuffer();
    const blocks = b.push('Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nAfter');
    expect(blocks).toEqual(['Intro', '```ts\nconst a = 1;\n\nconst b = 2;\n```']);
    expect(b.flush()).toBe('After');
  });

  it('works when text arrives one character at a time', () => {
    const b = new MarkdownBlockBuffer();
    const out: string[] = [];
    for (const ch of 'A\n\nB\n\nC') out.push(...b.push(ch));
    expect(out).toEqual(['A', 'B']);
    expect(b.flush()).toBe('C');
  });
});

describe('TurnRenderer', () => {
  function render(events: AgentEvent[]) {
    let out = '';
    const spinner = {
      started: [] as string[],
      start(t: string) {
        this.started.push(t);
      },
      stop() {},
    };
    const r = new TurnRenderer({
      write: (t) => (out += t),
      renderMarkdown: (md) => `<md>${md}</md>`,
      spinner,
    });
    events.forEach((e) => r.render(e));
    return { text: stripVTControlCharacters(out), spinner };
  }

  it('separates header, tool activity, answer and stats', () => {
    const { text, spinner } = render([
      { type: 'thinking', step: 1 },
      { type: 'tool_start', callId: 'a', name: 'read_file', label: 'README.md' },
      {
        type: 'tool_end',
        callId: 'a',
        name: 'read_file',
        ok: true,
        summary: '5 lines',
        durationMs: 2,
      },
      { type: 'tool_start', callId: 'b', name: 'read_file', label: '.env' },
      {
        type: 'tool_end',
        callId: 'b',
        name: 'read_file',
        ok: false,
        summary: 'blocked',
        durationMs: 1,
      },
      { type: 'thinking', step: 2 },
      { type: 'text', delta: 'It is a **demo**.\n\nDone' },
      {
        type: 'turn_end',
        durationMs: 2100,
        steps: 2,
        usage: { inputTokens: 1240, outputTokens: 96 },
      },
    ]);

    expect(text).toBe(
      [
        '',
        '● heph',
        '  ✓ read_file README.md · 5 lines · 2ms',
        '  ✗ read_file .env · blocked · 1ms',
        '',
        '  <md>It is a **demo**.</md>',
        '',
        '  <md>Done</md>',
        '',
        '  ── 2.1s · 2 steps · 1,240 in / 96 out tokens',
        '',
      ].join('\n'),
    );
    expect(spinner.started).toEqual([
      'thinking…',
      'read_file README.md',
      'read_file .env',
      'reading results…',
    ]);
  });

  it('REGRESSION: the spinner never erases streamed reasoning (it starts on a fresh line)', () => {
    const { text } = render([
      { type: 'thinking', step: 1 },
      { type: 'reasoning', delta: 'The user wants the name.' },
      { type: 'tool_start', callId: 'a', name: 'read_file', label: 'package.json' },
      { type: 'tool_end', callId: 'a', name: 'read_file', ok: true, durationMs: 1 },
    ]);
    // the reasoning line must END with a newline before the spinner draws
    expect(text).toContain('✻ The user wants the name.\n');
  });

  it('flushes a partial answer and marks an interruption', () => {
    const { text } = render([
      { type: 'thinking', step: 1 },
      { type: 'text', delta: 'Half an ans' },
      { type: 'interrupted' },
    ]);
    expect(text).toContain('<md>Half an ans</md>');
    expect(text).toContain('⏹ interrupted');
  });
});
