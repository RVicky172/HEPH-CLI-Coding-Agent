import { describe, expect, it } from 'vitest';
import { Agent, type AgentOptions } from '../../../../src/core/agent/Agent.js';
import type { AgentEvent } from '../../../../src/core/agent/AgentEvents.js';
import type { ToolOutcome, ToolRunner } from '../../../../src/core/agent/ToolRunner.js';
import { Conversation } from '../../../../src/core/conversation/Conversation.js';
import type { ToolCall } from '../../../../src/core/conversation/Message.js';
import { LLMError } from '../../../../src/core/errors/LLMError.js';
import {
  ScriptedProvider,
  toolCallReply,
  type ScriptedReply,
} from '../../../../src/llm/fake/ScriptedProvider.js';

/** A fake tool system: records calls, returns canned outputs. */
class FakeTools implements ToolRunner {
  readonly calls: ToolCall[] = [];
  constructor(private readonly outputs: Record<string, string> = {}) {}
  definitions() {
    return [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }];
  }
  describe(call: ToolCall) {
    return (JSON.parse(call.arguments) as { path?: string }).path ?? '';
  }
  async run(call: ToolCall): Promise<ToolOutcome> {
    this.calls.push(call);
    const output = this.outputs[call.name] ?? 'ok';
    return { ok: !output.startsWith('Error'), output, summary: 'done', durationMs: 1 };
  }
}

function setup(replies: ScriptedReply[], extra: Partial<AgentOptions> = {}) {
  const provider = new ScriptedProvider(replies);
  const conversation = new Conversation('SYSTEM');
  let clock = 1000;
  const agent = new Agent({
    provider,
    conversation,
    model: 'test-model',
    now: () => (clock += 250),
    ...extra,
  });
  return { agent, provider, conversation };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

const signal = () => new AbortController().signal;
const textOf = (events: AgentEvent[]) =>
  events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('Agent: plain chat (M1 behaviour)', () => {
  it('streams the answer as text events and ends the turn', async () => {
    const { agent } = setup(['Hello there, friend']);
    const events = await collect(agent.runTurn('hi', signal()));

    expect(events[0]).toEqual({ type: 'thinking', step: 1 });
    expect(textOf(events)).toBe('Hello there, friend');
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1); // really streamed
    expect(events.at(-1)).toEqual({
      type: 'turn_end',
      durationMs: 250,
      steps: 1,
      finishReason: 'stop',
    });
  });

  it('sends the whole history, with the system prompt, on every turn (that is the "memory")', async () => {
    const { agent, provider } = setup(['first answer', 'second answer']);
    await collect(agent.runTurn('one', signal()));
    await collect(agent.runTurn('two', signal()));

    expect(provider.requests[1]?.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'two' },
    ]);
    expect(provider.requests[1]?.model).toBe('test-model');
  });

  it('passes temperature only when configured, and no tools when there are none', async () => {
    const a = setup(['x']);
    await collect(a.agent.runTurn('q', signal()));
    expect(a.provider.requests[0]).not.toHaveProperty('temperature');
    expect(a.provider.requests[0]).not.toHaveProperty('tools');

    const b = setup(['x'], { temperature: 0.2 });
    await collect(b.agent.runTurn('q', signal()));
    expect(b.provider.requests[0]?.temperature).toBe(0.2);
  });

  it('forwards reasoning but does not store it in the history', async () => {
    const { agent, conversation } = setup([
      [{ type: 'reasoning', delta: 'hmm…' }, { type: 'text', delta: 'answer' }, { type: 'done' }],
    ]);
    const events = await collect(agent.runTurn('q', signal()));
    expect(events[1]).toEqual({ type: 'reasoning', delta: 'hmm…' });
    expect(conversation.messages().at(-1)).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('on provider error: yields an error event and rolls the turn back', async () => {
    const failure = new LLMError('connection', 'server down');
    const { agent, conversation } = setup([failure, 'works now']);

    const events = await collect(agent.runTurn('hello?', signal()));
    expect(types(events)).toEqual(['thinking', 'error']);
    expect(conversation.messages()).toEqual([{ role: 'system', content: 'SYSTEM' }]);

    await collect(agent.runTurn('hello?', signal())); // a retry produces a clean history
    expect(conversation.messages().map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('on interrupt: stops streaming and keeps the partial answer, marked as interrupted', async () => {
    const { agent, conversation } = setup(['one two three four five six']);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const e of agent.runTurn('count', controller.signal)) {
      events.push(e);
      if (textOf(events) === 'one two ') controller.abort(); // Ctrl+C mid-answer
    }

    expect(events.at(-1)).toEqual({ type: 'interrupted' });
    expect(textOf(events)).toBe('one two ');
    expect(conversation.messages().at(-1)?.content).toBe('one two \n\n[interrupted by the user]');
  });

  it('on interrupt before any text: removes the unanswered user message', async () => {
    const { agent, conversation } = setup(['never shown']);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(agent.runTurn('q', controller.signal));
    expect(events.at(-1)).toEqual({ type: 'interrupted' });
    expect(conversation.length).toBe(1);
  });

  it('reset() and setModel()', async () => {
    const { agent, provider, conversation } = setup(['a']);
    agent.setModel('other');
    await collect(agent.runTurn('q', signal()));
    expect(provider.requests[0]?.model).toBe('other');
    agent.reset();
    expect(conversation.messages()).toEqual([{ role: 'system', content: 'SYSTEM' }]);
  });
});

describe('Agent: the tool loop (M2)', () => {
  it('runs a requested tool, sends the result back, and continues until a text answer', async () => {
    const tools = new FakeTools({ read_file: '1\tconst answer = 42;' });
    const { agent, provider, conversation } = setup(
      [
        toolCallReply({ name: 'read_file', args: { path: 'a.ts' }, id: 'c1' }),
        'The answer is 42 (a.ts:1).',
      ],
      { tools },
    );

    const events = await collect(agent.runTurn('what is the answer?', signal()));

    expect(types(events)).toEqual([
      'thinking', // step 1: model decides to read a file
      'tool_start',
      'tool_end',
      'thinking', // step 2: model reads the result and answers
      ...Array<string>(events.length - 5).fill('text'),
      'turn_end',
    ]);
    expect(events[1]).toEqual({
      type: 'tool_start',
      callId: 'c1',
      name: 'read_file',
      label: 'a.ts',
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', steps: 2 });
    expect(tools.calls).toHaveLength(1);

    // The second request contains the tool call AND its result, so the model sees the file.
    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: '1\tconst answer = 42;' },
    ]);
    expect(provider.requests[0]?.tools?.[0]?.name).toBe('read_file');
    expect(conversation.messages().at(-1)).toEqual({
      role: 'assistant',
      content: 'The answer is 42 (a.ts:1).',
    });
  });

  it('runs several tool calls from one step, in order', async () => {
    const tools = new FakeTools();
    const { agent } = setup(
      [
        toolCallReply(
          { name: 'read_file', args: { path: 'a' }, id: 'x' },
          { name: 'read_file', args: { path: 'b' }, id: 'y' },
        ),
        'done',
      ],
      { tools },
    );
    await collect(agent.runTurn('q', signal()));
    expect(tools.calls.map((c) => c.id)).toEqual(['x', 'y']);
  });

  it('a failing tool does not stop the loop: the error goes to the model', async () => {
    const tools = new FakeTools({ read_file: 'Error: File not found' });
    const { agent, provider } = setup(
      [toolCallReply({ name: 'read_file', args: { path: 'nope' } }), 'That file does not exist.'],
      { tools },
    );
    const events = await collect(agent.runTurn('q', signal()));
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: 'Error: File not found',
    });
    expect(events.at(-1)?.type).toBe('turn_end');
  });

  it('stops after maxSteps if the model never gives a final answer', async () => {
    const tools = new FakeTools();
    const loopForever = Array.from({ length: 5 }, () =>
      toolCallReply({ name: 'read_file', args: { path: 'a' } }),
    );
    const { agent } = setup(loopForever, { tools, maxSteps: 3 });
    const events = await collect(agent.runTurn('q', signal()));

    expect(tools.calls).toHaveLength(3);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({
      message: expect.stringContaining('3 steps'),
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', steps: 3 });
  });

  it('sums token usage over all steps', async () => {
    const tools = new FakeTools();
    const { agent } = setup(
      [
        [
          { type: 'tool_call', id: 'c', name: 'read_file', arguments: '{}' },
          { type: 'done', usage: { inputTokens: 100, outputTokens: 10 } },
        ],
        [
          { type: 'text', delta: 'ok' },
          { type: 'done', usage: { inputTokens: 150, outputTokens: 5 } },
        ],
      ],
      { tools },
    );
    const end = (await collect(agent.runTurn('q', signal()))).at(-1);
    expect(end).toMatchObject({ usage: { inputTokens: 250, outputTokens: 15 } });
  });

  it('interrupt during tools: every tool call still gets a result (history stays valid)', async () => {
    const tools = new FakeTools();
    const controller = new AbortController();
    const { agent, conversation } = setup(
      [
        toolCallReply(
          { name: 'read_file', args: { path: 'a' }, id: 'first' },
          { name: 'read_file', args: { path: 'b' }, id: 'second' },
        ),
      ],
      { tools },
    );
    for await (const e of agent.runTurn('q', controller.signal)) {
      if (e.type === 'tool_end') controller.abort(); // Ctrl+C after the first tool
    }
    const toolResults = conversation.messages().filter((m) => m.role === 'tool');
    expect(toolResults).toEqual([
      { role: 'tool', toolCallId: 'first', content: 'ok' },
      { role: 'tool', toolCallId: 'second', content: 'Cancelled: the user interrupted.' },
    ]);
    expect(tools.calls).toHaveLength(1);
  });

  it('an error in a later step rolls back the WHOLE turn, tool steps included', async () => {
    const tools = new FakeTools();
    const { agent, conversation } = setup(
      [toolCallReply({ name: 'read_file', args: {} }), new LLMError('timeout', 'slow')],
      { tools },
    );
    const events = await collect(agent.runTurn('q', signal()));
    expect(events.at(-1)?.type).toBe('error');
    expect(conversation.messages()).toEqual([{ role: 'system', content: 'SYSTEM' }]);
  });
});
