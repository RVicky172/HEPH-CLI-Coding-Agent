import { describe, expect, it } from 'vitest';
import { Agent } from '../../../src/core/agent/Agent.js';
import type { AgentEvent } from '../../../src/core/agent/AgentEvents.js';
import { Conversation } from '../../../src/core/conversation/Conversation.js';
import { ScriptedProvider } from '../../../src/llm/fake/ScriptedProvider.js';
import { ChatRepl } from '../../../src/ui/ChatRepl.js';
import { BUILTIN_COMMANDS } from '../../../src/ui/slash-commands/builtins.js';
import { SlashCommandRegistry } from '../../../src/ui/slash-commands/SlashCommandRegistry.js';
import type { InputSource, InterruptSource, OutputSink } from '../../../src/ui/UserInterface.js';
import type { PermissionMode } from '../../../src/permissions/PermissionMode.js';
import type { SessionControls } from '../../../src/ui/slash-commands/SlashCommand.js';

/** Fake session: a mode and an undo stack of descriptions. */
function fakeSession(undoStack: string[] = []) {
  let mode: PermissionMode = 'ask';
  const grants: string[] = ['edit_file'];
  const session: SessionControls = {
    get mode() {
      return mode;
    },
    setMode: (m) => (mode = m),
    reads: 'ask',
    get sessionGrants() {
      return grants;
    },
    clearSessionGrants: () => grants.splice(0),
    undo: async () => undoStack.pop(),
  };
  return session;
}

/** A fake terminal: scripted input lines, recorded output. */
class FakeTerminal implements InputSource, OutputSink, InterruptSource {
  readonly events: AgentEvent[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: unknown[] = [];
  #handler: (() => void) | undefined;

  constructor(private readonly lines: string[]) {}

  async readLine() {
    return this.lines.shift() ?? null;
  }
  render(e: AgentEvent) {
    this.events.push(e);
  }
  info(m: string) {
    this.infos.push(m);
  }
  warn(m: string) {
    this.warnings.push(m);
  }
  error(e: unknown) {
    this.errors.push(e);
  }
  onInterrupt(h: () => void) {
    this.#handler = h;
    return () => (this.#handler = undefined);
  }
  get hasInterruptHandler() {
    return this.#handler !== undefined;
  }
}

function setup(lines: string[], replies: string[] = [], session = fakeSession()) {
  const provider = new ScriptedProvider(replies);
  const conversation = new Conversation('sys');
  const agent = new Agent({ provider, conversation, model: 'm' });
  const term = new FakeTerminal(lines);
  const repl = new ChatRepl({
    agent,
    input: term,
    output: term,
    interrupts: term,
    commands: new SlashCommandRegistry(BUILTIN_COMMANDS),
    session,
  });
  return { repl, term, provider, conversation, agent, session };
}

describe('ChatRepl', () => {
  it('sends user lines to the agent and renders the answer', async () => {
    const { repl, term } = setup(['hello'], ['Hi!']);
    await repl.run();
    expect(term.events.some((e) => e.type === 'text')).toBe(true);
    expect(term.events.at(-1)?.type).toBe('turn_end');
    expect(term.hasInterruptHandler).toBe(false); // cleaned up after the turn
  });

  it('ignores empty lines and stops at end of input', async () => {
    const { repl, provider } = setup(['', '   ']);
    await repl.run();
    expect(provider.requests).toHaveLength(0);
  });

  it('/exit stops before reading more lines', async () => {
    const { repl, provider } = setup(['/exit', 'never sent'], ['x']);
    await repl.run();
    expect(provider.requests).toHaveLength(0);
  });

  it('/clear resets the conversation', async () => {
    const { repl, conversation } = setup(['hi', '/clear'], ['hello']);
    await repl.run();
    expect(conversation.messages()).toEqual([{ role: 'system', content: 'sys' }]);
  });

  it('/model switches the model', async () => {
    const { repl, agent } = setup(['/model other-model']);
    await repl.run();
    expect(agent.model).toBe('other-model');
  });

  it('/help lists all commands', async () => {
    const { repl, term } = setup(['/help']);
    await repl.run();
    for (const name of ['/help', '/clear', '/model', '/exit'])
      expect(term.infos[0]).toContain(name);
  });

  it('a multi-line paste is ONE turn, even if it starts with "/"', async () => {
    const pasted = '/src/app.ts\nconst x = 1;\nexport default x;';
    const { repl, provider } = setup([pasted], ['It exports 1.']);
    await repl.run();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: pasted });
  });

  it('/mode shows the modes; /mode <x> switches and tells the model', async () => {
    const { repl, term, session, provider } = setup(['/mode', '/mode read-only', 'hi'], ['ok']);
    await repl.run();
    expect(term.infos[0]).toContain('auto-edit');
    expect(session.mode).toBe('read-only');
    expect(session.sessionGrants).toEqual([]); // stricter mode forgets "always" grants
    expect(provider.requests[0]?.messages.at(-1)?.content).toMatch(
      /^\[Note from heph: The user switched the permission mode to "read-only"/,
    );
  });

  it('/mode rejects unknown modes', async () => {
    const { repl, term, session } = setup(['/mode yolo']);
    await repl.run();
    expect(term.warnings[0]).toContain('yolo');
    expect(session.mode).toBe('ask');
  });

  it('/undo reverts and the model learns about it on the next message', async () => {
    const { repl, term, provider } = setup(
      ['/undo', '/undo', 'what now?'],
      ['ok'],
      fakeSession(['restored src/a.ts to its state before edit_file']),
    );
    await repl.run();
    expect(term.infos[0]).toContain('restored src/a.ts');
    expect(term.infos[1]).toContain('Nothing to undo');
    expect(provider.requests[0]?.messages.at(-1)?.content).toContain('The user ran /undo');
    expect(provider.requests[0]?.messages.at(-1)?.content).toMatch(/what now\?$/);
  });

  it('a unique prefix runs the command ("/und" = "/undo", "/he" = "/help")', async () => {
    const { repl, term } = setup(['/und', '/he']);
    await repl.run();
    expect(term.infos[0]).toContain('Nothing to undo');
    expect(term.infos[1]).toContain('Commands:');
  });

  it('an ambiguous prefix lists the candidates', async () => {
    const { repl, term } = setup(['/m']);
    await repl.run();
    expect(term.warnings[0]).toMatch(/\/mode or \/model/);
  });

  it('unknown slash commands warn instead of being sent to the model', async () => {
    const { repl, term, provider } = setup(['/nope']);
    await repl.run();
    expect(term.warnings[0]).toContain('/nope');
    expect(provider.requests).toHaveLength(0);
  });
});
