import { describe, expect, it } from 'vitest';
import { Conversation } from '../../../../src/core/conversation/Conversation.js';

describe('Conversation', () => {
  it('starts with the system prompt', () => {
    expect(new Conversation('be nice').messages()).toEqual([
      { role: 'system', content: 'be nice' },
    ]);
  });

  it('records user and assistant messages in order', () => {
    const c = new Conversation();
    c.addUser('hi');
    c.addAssistant('hello');
    expect(c.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('clear() keeps only the system prompt', () => {
    const c = new Conversation('sys');
    c.addUser('hi');
    c.clear();
    expect(c.messages()).toEqual([{ role: 'system', content: 'sys' }]);
  });

  it('removeLast() never removes the system prompt', () => {
    const c = new Conversation('sys');
    expect(c.removeLast()).toBeUndefined();
    expect(c.length).toBe(1);
  });

  it('messages() returns a copy', () => {
    const c = new Conversation();
    (c.messages() as unknown[]).push('junk');
    expect(c.length).toBe(0);
  });
});
