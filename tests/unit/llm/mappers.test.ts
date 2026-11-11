import { describe, expect, it } from 'vitest';
import { ToolCallAssembler, toOpenAIMessages } from '../../../src/llm/openai-compatible/mappers.js';

describe('toOpenAIMessages', () => {
  it('maps tool calls and tool results to the OpenAI format', () => {
    expect(
      toOpenAIMessages([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'file text' },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'file text' },
    ]);
  });
});

describe('ToolCallAssembler', () => {
  it('glues streamed fragments back into complete calls, keyed by index', () => {
    const a = new ToolCallAssembler();
    a.add([
      { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } },
    ]);
    a.add([{ index: 0, function: { arguments: '{"pa' } }]);
    a.add([{ index: 1, id: 'call_b', function: { name: 'glob', arguments: '{"pattern":"*"}' } }]);
    a.add([{ index: 0, function: { arguments: 'th":"x.ts"}' } }]);

    expect(a.finish()).toEqual([
      { id: 'call_a', name: 'read_file', arguments: '{"path":"x.ts"}' },
      { id: 'call_b', name: 'glob', arguments: '{"pattern":"*"}' },
    ]);
  });

  it('generates ids when a server omits them', () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 0, function: { name: 'grep', arguments: '{}' } }]);
    expect(a.finish()[0]?.id).toMatch(/^call_0_/);
  });
});
