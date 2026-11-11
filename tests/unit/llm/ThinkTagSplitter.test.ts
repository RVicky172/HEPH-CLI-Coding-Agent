import { describe, expect, it } from 'vitest';
import { ThinkTagSplitter } from '../../../src/llm/openai-compatible/ThinkTagSplitter.js';

function run(chunks: string[]) {
  const s = new ThinkTagSplitter();
  let text = '';
  let reasoning = '';
  for (const c of [...chunks.map((c) => s.push(c)), s.flush()]) {
    text += c.text;
    reasoning += c.reasoning;
  }
  return { text, reasoning };
}

describe('ThinkTagSplitter', () => {
  it('separates <think> content from the answer', () => {
    expect(run(['<think>plan it</think>The answer.'])).toEqual({
      text: 'The answer.',
      reasoning: 'plan it',
    });
  });

  it('handles tags split across chunks (streaming)', () => {
    expect(run(['<th', 'ink>hm', 'm</thi', 'nk>Done'])).toEqual({ text: 'Done', reasoning: 'hmm' });
  });

  it('passes normal text through, including a lone "<"', () => {
    expect(run(['a < b and ', '<b>bold</b>'])).toEqual({
      text: 'a < b and <b>bold</b>',
      reasoning: '',
    });
  });

  it('an unclosed think block at the end is still reasoning', () => {
    expect(run(['<think>never closed'])).toEqual({ text: '', reasoning: 'never closed' });
  });
});
