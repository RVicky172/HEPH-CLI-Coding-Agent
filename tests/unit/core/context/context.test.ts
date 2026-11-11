import { describe, expect, it } from 'vitest';
import { Agent } from '../../../../src/core/agent/Agent.js';
import type { AgentEvent } from '../../../../src/core/agent/AgentEvents.js';
import type { ToolRunner } from '../../../../src/core/agent/ToolRunner.js';
import { ContextManager, SUMMARY_MARKER } from '../../../../src/core/context/ContextManager.js';
import { TokenEstimator } from '../../../../src/core/context/TokenEstimator.js';
import { Conversation } from '../../../../src/core/conversation/Conversation.js';
import type { Message } from '../../../../src/core/conversation/Message.js';
import { LLMError } from '../../../../src/core/errors/LLMError.js';
import { ScriptedProvider, toolCallReply } from '../../../../src/llm/fake/ScriptedProvider.js';

const big = (n: number) => 'x'.repeat(n);

/** A conversation of N turns, each: user → assistant(tool call) → tool result → assistant answer. */
function turns(n: number, toolOutputChars = 2000): Message[] {
  const out: Message[] = [{ role: 'system', content: 'SYS' }];
  for (let i = 1; i <= n; i++) {
    out.push(
      { role: 'user', content: `question ${i}` },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: `c${i}`, content: big(toolOutputChars) },
      { role: 'assistant', content: `answer ${i}` },
    );
  }
  return out;
}

/** Every tool call must be followed by its result, or the API rejects the request. */
function pairsAreValid(messages: readonly Message[]): boolean {
  const pending = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') m.toolCalls?.forEach((c) => pending.add(c.id));
    if (m.role === 'tool') {
      if (!pending.has(m.toolCallId)) return false;
      pending.delete(m.toolCallId);
    }
  }
  return pending.size === 0;
}

describe('TokenEstimator', () => {
  it('estimates ~3.6 characters per token, plus per-message overhead', () => {
    const e = new TokenEstimator();
    expect(e.text(big(360))).toBe(100);
    expect(e.message({ role: 'user', content: big(360) })).toBe(104);
  });

  it('calibrates towards the real counts the server reports', () => {
    const e = new TokenEstimator();
    for (let i = 0; i < 8; i++) e.calibrate(e.text(big(3600)), 1500); // real: 1500, estimate: ~1000
    expect(e.ratio).toBeCloseTo(1.5, 1);
    expect(e.text(big(3600))).toBeGreaterThan(1450);
  });

  it('ignores nonsense and clamps extremes', () => {
    const e = new TokenEstimator();
    e.calibrate(0, 100);
    expect(e.ratio).toBe(1);
    for (let i = 0; i < 20; i++) e.calibrate(e.text('abc'), 1_000_000);
    expect(e.ratio).toBe(3);
  });
});

describe('ContextManager.fit (non-destructive)', () => {
  const manager = (window: number) =>
    new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: window,
      reserveForOutput: 0,
    });

  it('changes nothing when everything fits', () => {
    const messages = turns(2, 100);
    const fit = manager(10_000).fit(messages);
    expect(fit.messages).toEqual(messages);
    expect(fit.actions).toEqual([]);
  });

  it('first shortens OLD tool outputs, keeping the recent turns intact', () => {
    const messages = turns(4, 4000); // ~4.5k tokens
    const fit = manager(3000).fit(messages);
    expect(fit.actions[0]).toMatch(/shortened 2 old tool outputs/);
    const tools = fit.messages.filter((m) => m.role === 'tool');
    expect(tools.slice(0, 2).every((m) => m.content.startsWith('[older tool output removed'))).toBe(
      true,
    );
    expect(tools.slice(2).every((m) => m.content === big(4000))).toBe(true);
    expect(fit.estimatedTokens).toBeLessThanOrEqual(3000);
  });

  it('then leaves out whole oldest turns, never breaking tool-call pairs, never the current turn', () => {
    const messages = [...turns(6, 300), { role: 'user' as const, content: `current ${big(2000)}` }];
    const fit = manager(900).fit(messages);
    expect(fit.actions.some((a) => /left out \d+ oldest turn/.test(a))).toBe(true);
    expect(pairsAreValid(fit.messages)).toBe(true);
    expect(fit.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(fit.messages.at(-1)?.content).toMatch(/^current/);
  });

  it('does not touch the original array', () => {
    const messages = turns(4, 4000);
    const copy = structuredClone(messages);
    manager(1000).fit(messages);
    expect(messages).toEqual(copy);
  });
});

describe('ContextManager.compact (summary)', () => {
  it('replaces old turns by a summary, keeps the recent ones, and shrinks the context', async () => {
    const conversation = new Conversation('SYS');
    conversation.replaceHistory(turns(5, 5000)); // ~7k tokens: above 75% of 8k
    let transcript = '';
    const manager = new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: 8000,
      reserveForOutput: 0,
      keepRecentTurns: 2,
      summarize: async (t) => {
        transcript = t;
        return '- the user asked 3 questions about files';
      },
    });

    expect(manager.shouldCompact(conversation.messages())).toBe(true);
    const result = await manager.compact(conversation, new AbortController().signal);

    expect(result?.turns).toBe(3);
    expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore / 2);
    expect(transcript).toContain('USER: question 1');
    expect(transcript).not.toContain('question 4'); // recent turns are not summarised
    const msgs = conversation.messages();
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[1]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(
      msgs
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .slice(1),
    ).toEqual(['question 4', 'question 5']);
    expect(pairsAreValid(msgs)).toBe(true);
  });

  it('does not compact without a summariser, below the threshold, or with too few turns', () => {
    const estimator = new TokenEstimator();
    expect(new ContextManager({ estimator, contextWindow: 100 }).shouldCompact(turns(5))).toBe(
      false,
    );
    const withSummary = (w: number) =>
      new ContextManager({
        estimator,
        contextWindow: w,
        reserveForOutput: 0,
        summarize: async () => 's',
      });
    expect(withSummary(1_000_000).shouldCompact(turns(5))).toBe(false);
    expect(withSummary(100).shouldCompact(turns(2))).toBe(false); // only the 2 recent turns exist
  });
});

describe('Agent + context', () => {
  const noTools: ToolRunner = {
    definitions: () => [{ name: 'read_file', description: 'r', parameters: { type: 'object' } }],
    describe: () => '',
    run: async () => ({ ok: true, output: big(3000), durationMs: 1 }),
  };

  async function collect(stream: AsyncIterable<AgentEvent>) {
    const events: AgentEvent[] = [];
    for await (const e of stream) events.push(e);
    return events;
  }

  it('compacts automatically when the context fills up, then continues normally', async () => {
    const conversation = new Conversation('SYS');
    conversation.replaceHistory(turns(4, 5000)); // ~5.7k tokens: above 75% of 6k
    // reply 1 is consumed by the summariser, reply 2 is the real answer
    const provider = new ScriptedProvider(['- summary of earlier work', 'Here is the answer.']);
    const context = new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: 6000,
      reserveForOutput: 0,
      summarize: async (t, signal) => {
        let s = '';
        for await (const c of provider.chat(
          { model: 'm', messages: [{ role: 'user', content: t }] },
          signal,
        )) {
          if (c.type === 'text') s += c.delta;
        }
        return s;
      },
    });
    const agent = new Agent({ provider, conversation, model: 'm', tools: noTools, context });

    const events = await collect(agent.runTurn('next question', new AbortController().signal));

    expect(events[0]).toEqual({ type: 'compacting' });
    expect(events[1]).toMatchObject({ type: 'compacted', turns: 3 });
    const end = events.at(-1);
    expect(end).toMatchObject({ type: 'turn_end', context: { limitTokens: 6000 } });
    expect(end?.type === 'turn_end' && end.context!.usedTokens).toBeLessThan(6000 * 0.75);
    // the model's real request contains the summary, not the old turns
    const sent = provider.requests[1]!.messages;
    expect(sent.some((m) => m.content.includes('summary of earlier work'))).toBe(true);
    expect(sent.some((m) => m.content === 'question 1')).toBe(false);
  });

  it('reports trimming when a request had to be shortened to fit', async () => {
    const conversation = new Conversation('SYS');
    conversation.replaceHistory(turns(3, 6000));
    const context = new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: 3000,
      reserveForOutput: 0,
    });
    const agent = new Agent({
      provider: new ScriptedProvider(['ok']),
      conversation,
      model: 'm',
      context,
    });
    const events = await collect(agent.runTurn('q', new AbortController().signal));
    expect(events.find((e) => e.type === 'context_trimmed')).toMatchObject({
      actions: expect.arrayContaining([expect.stringMatching(/shortened/)]),
    });
    // non-destructive: the stored conversation still has the full outputs
    expect(
      conversation
        .messages()
        .filter((m) => m.role === 'tool')
        .every((m) => m.content.length === 6000),
    ).toBe(true);
  });

  it('calibrates the estimator from the usage the server reports', async () => {
    const estimator = new TokenEstimator();
    const context = new ContextManager({ estimator, contextWindow: 100_000 });
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'ok' },
        { type: 'done', usage: { inputTokens: 5000, outputTokens: 1 } },
      ],
    ]);
    const conversation = new Conversation(big(3600)); // estimated ~1000 tokens
    const agent = new Agent({ provider, conversation, model: 'm', context });
    await collect(agent.runTurn('q', new AbortController().signal));
    expect(estimator.ratio).toBeGreaterThan(2);
  });

  it('an error after compaction still rolls back only the current turn', async () => {
    const conversation = new Conversation('SYS');
    conversation.replaceHistory(turns(4, 5000)); // ~5.7k tokens: above 75% of 6k
    const context = new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: 6000,
      reserveForOutput: 0,
      summarize: async () => 'summary',
    });
    const agent = new Agent({
      provider: new ScriptedProvider([new LLMError('connection', 'down')]),
      conversation,
      model: 'm',
      context,
    });
    const events = await collect(agent.runTurn('doomed', new AbortController().signal));
    expect(events.at(-1)?.type).toBe('error');
    const msgs = conversation.messages();
    expect(msgs.some((m) => m.content === 'doomed')).toBe(false);
    expect(msgs[1]?.content.startsWith(SUMMARY_MARKER)).toBe(true); // the summary stays
    expect(pairsAreValid(msgs)).toBe(true);
  });

  it('REGRESSION: compacts at most once per turn (a second one gained nothing and cost a model call)', async () => {
    const conversation = new Conversation('SYS');
    conversation.replaceHistory(turns(4, 5000));
    let summaries = 0;
    const context = new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: 6000,
      reserveForOutput: 0,
      summarize: async () => {
        summaries++;
        return 'summary';
      },
    });
    const bigTools: ToolRunner = {
      ...noTools,
      run: async () => ({ ok: true, output: big(20_000), durationMs: 1 }),
    };
    const agent = new Agent({
      provider: new ScriptedProvider([toolCallReply({ name: 'read_file', args: {} }), 'done']),
      conversation,
      model: 'm',
      tools: bigTools,
      context,
    });
    await collect(agent.runTurn('q', new AbortController().signal));
    expect(summaries).toBe(1);
  });

  it('REGRESSION: does not compact when the old part is too small to be worth a model call', () => {
    const messages = [...turns(1, 100), ...turns(2, 9000).slice(1)]; // tiny old turn, huge recent turns
    const context = new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: 4000,
      reserveForOutput: 0,
      summarize: async () => 's',
    });
    expect(context.usage(messages).ratio).toBeGreaterThan(1);
    expect(context.shouldCompact(messages)).toBe(false);
  });

  it('REGRESSION: contextUsage reports what is SENT (after fitting), not the whole stored history', () => {
    const conversation = new Conversation('SYS');
    conversation.replaceHistory(turns(3, 9000));
    const context = new ContextManager({
      estimator: new TokenEstimator(),
      contextWindow: 4000,
      reserveForOutput: 0,
    });
    const agent = new Agent({
      provider: new ScriptedProvider([]),
      conversation,
      model: 'm',
      context,
    });
    expect(context.usage(conversation.messages()).ratio).toBeGreaterThan(1.5);
    expect(agent.contextUsage()!.ratio).toBeLessThanOrEqual(1);
  });

  it('works with tool calls inside the turn', async () => {
    const context = new ContextManager({ estimator: new TokenEstimator(), contextWindow: 50_000 });
    const agent = new Agent({
      provider: new ScriptedProvider([toolCallReply({ name: 'read_file', args: {} }), 'done']),
      conversation: new Conversation('SYS'),
      model: 'm',
      tools: noTools,
      context,
    });
    const events = await collect(agent.runTurn('q', new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', steps: 2 });
    expect(agent.contextReport()).toMatchObject({ messages: 4, window: 50_000 });
  });
});
