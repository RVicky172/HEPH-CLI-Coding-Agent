/**
 * LIVE tests against a real LM Studio server. Run with:  npm run test:llm
 *
 * They are skipped automatically when the server isn't reachable, so they
 * never break CI. They assert OUTCOMES (the answer contains "pong"), never
 * exact text, because LLM output varies between runs and models.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/core/agent/Agent.js';
import type { AgentEvent } from '../../src/core/agent/AgentEvents.js';
import { Conversation } from '../../src/core/conversation/Conversation.js';
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible/OpenAICompatibleProvider.js';
import { resolveModel } from '../../src/llm/ProviderFactory.js';
import { buildSystemPrompt } from '../../src/core/context/SystemPromptBuilder.js';
import { ListDirectoryTool } from '../../src/tools/fs/ListDirectoryTool.js';
import { ReadFileTool } from '../../src/tools/fs/ReadFileTool.js';
import { ToolExecutor } from '../../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../../src/tools/ToolRegistry.js';
import { Workspace } from '../../src/workspace/Workspace.js';
import { createTempDir, removeTempDir } from '../helpers/tempWorkspace.js';
import { FakeApprover } from '../helpers/FakeApprover.js';
import { PolicyPermissionGate } from '../../src/permissions/PolicyPermissionGate.js';
import { EditFileTool } from '../../src/tools/fs/EditFileTool.js';
import { WriteFileTool } from '../../src/tools/fs/WriteFileTool.js';
import { CheckpointStore } from '../../src/workspace/CheckpointStore.js';
import { FileReadTracker } from '../../src/workspace/FileReadTracker.js';
import { WorkspaceWriter } from '../../src/workspace/WorkspaceWriter.js';
import { NodeShell } from '../../src/shell/NodeShell.js';
import { RunCommandTool } from '../../src/tools/shell/RunCommandTool.js';

const BASE_URL = process.env.HEPH_BASE_URL ?? 'http://localhost:1234/v1';

const reachable = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

if (!reachable) console.warn(`⚠ LM Studio not reachable at ${BASE_URL}: live tests skipped.`);

async function answer(agent: Agent, prompt: string): Promise<string> {
  let text = '';
  for await (const e of agent.runTurn(
    prompt,
    new AbortController().signal,
  ) as AsyncIterable<AgentEvent>) {
    if (e.type === 'text') text += e.delta;
    if (e.type === 'error') throw e.error;
  }
  return text;
}

describe.skipIf(!reachable)('LM Studio (live)', () => {
  const provider = new OpenAICompatibleProvider({
    name: 'local',
    baseURL: BASE_URL,
    apiKey: 'lm-studio',
  });

  it('lists at least one chat model', async () => {
    const model = await resolveModel(provider, process.env.HEPH_MODEL ?? 'auto');
    expect(model).toBeTruthy();
  });

  it('streams an answer', async () => {
    const model = await resolveModel(provider, process.env.HEPH_MODEL ?? 'auto');
    const agent = new Agent({ provider, model, conversation: new Conversation(), temperature: 0 });
    const text = await answer(agent, 'Reply with exactly one word: pong');
    expect(text.toLowerCase()).toContain('pong');
  });

  it('uses tools to read a file it has never seen (the agent loop works end to end)', async () => {
    const root = createTempDir({
      'notes/plan.md': '# Plan\n\nThe secret codename is BLUE-HERON.\n',
    });
    try {
      const model = await resolveModel(provider, process.env.HEPH_MODEL ?? 'auto');
      const workspace = Workspace.open(root);
      const tools = new ToolExecutor(
        new ToolRegistry().register(new ListDirectoryTool()).register(new ReadFileTool()),
        workspace,
      );
      const agent = new Agent({
        provider,
        model,
        tools,
        temperature: 0,
        conversation: new Conversation(
          buildSystemPrompt({
            os: 'test',
            shell: 'sh',
            cwd: root,
            date: '2026-01-01',
            model,
            tools: ['list_directory', 'read_file'],
          }),
        ),
      });
      const text = await answer(agent, 'What is the secret codename in the plan file? Find it.');
      expect(text).toContain('BLUE-HERON');
    } finally {
      removeTempDir(root);
    }
  });

  it('edits a file after approval, and leaves it alone when denied', async () => {
    const original = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';
    for (const choice of ['allow', 'deny'] as const) {
      const root = createTempDir({ 'src/math.ts': original });
      try {
        const model = await resolveModel(provider, process.env.HEPH_MODEL ?? 'auto');
        const workspace = Workspace.open(root);
        const reads = new FileReadTracker();
        const writer = new WorkspaceWriter(workspace, new CheckpointStore(), reads);
        const approver = new FakeApprover(Array.from({ length: 5 }, () => ({ decision: choice })));
        const registry = new ToolRegistry()
          .register(new ReadFileTool(reads))
          .register(new EditFileTool(writer))
          .register(new WriteFileTool(writer));
        const agent = new Agent({
          provider,
          model,
          temperature: 0,
          tools: new ToolExecutor(registry, workspace, {
            gate: new PolicyPermissionGate(approver, 'ask'),
          }),
          conversation: new Conversation(
            buildSystemPrompt({
              os: 'test',
              shell: 'sh',
              cwd: root,
              date: '2026-01-01',
              model,
              tools: registry.names(),
              mode: 'ask',
            }),
          ),
        });
        await answer(agent, 'Add an exported multiply(a, b) function to src/math.ts.');
        const after = fs.readFileSync(path.join(root, 'src/math.ts'), 'utf8');

        expect(approver.asked.length).toBeGreaterThan(0); // it asked before changing
        if (choice === 'allow') expect(after).toMatch(/function multiply/);
        else expect(after).toBe(original); // "no" means NO
      } finally {
        removeTempDir(root);
      }
    }
  });

  it('runs a command (after approval) and reports its real output', async () => {
    const root = createTempDir({ 'package.json': '{"name":"demo"}' });
    try {
      const model = await resolveModel(provider, process.env.HEPH_MODEL ?? 'auto');
      const workspace = Workspace.open(root);
      const approver = new FakeApprover(
        Array.from({ length: 5 }, () => ({ decision: 'allow' as const })),
      );
      const shell = new NodeShell();
      const registry = new ToolRegistry().register(new RunCommandTool(shell));
      const agent = new Agent({
        provider,
        model,
        temperature: 0,
        tools: new ToolExecutor(registry, workspace, {
          gate: new PolicyPermissionGate(approver, 'ask'),
        }),
        conversation: new Conversation(
          buildSystemPrompt({
            os: process.platform,
            shell: shell.name,
            cwd: root,
            date: '2026-01-01',
            model,
            tools: registry.names(),
            mode: 'ask',
          }),
        ),
      });
      const text = await answer(
        agent,
        'Run this exact command and tell me the number it prints: node -e "console.log(6*7+1000)"',
      );
      expect(approver.asked[0]?.preview).toMatchObject({ kind: 'command' });
      expect(text).toContain('1042');
    } finally {
      removeTempDir(root);
    }
  });

  it('remembers earlier turns (conversation history works)', async () => {
    const model = await resolveModel(provider, process.env.HEPH_MODEL ?? 'auto');
    const agent = new Agent({ provider, model, conversation: new Conversation(), temperature: 0 });
    await answer(agent, 'My favourite colour is turquoise. Just say OK.');
    const text = await answer(agent, 'What is my favourite colour? Answer with one word.');
    expect(text.toLowerCase()).toContain('turquoise');
  });
});
