import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { ChatOptions, CliActions, GlobalOptions, RunOptions } from './cli/program.js';
import { ConfigError } from './config/ConfigError.js';
import { loadConfig, type CliFlags, type LoadedConfig } from './config/ConfigLoader.js';
import { projectConfigPath, userConfigPath } from './config/paths.js';
import { Agent } from './core/agent/Agent.js';
import type { AgentEvent } from './core/agent/AgentEvents.js';
import { ContextManager } from './core/context/ContextManager.js';
import { createLlmSummarizer } from './core/context/llmSummarizer.js';
import { buildSystemPrompt } from './core/context/SystemPromptBuilder.js';
import { TokenEstimator } from './core/context/TokenEstimator.js';
import { Conversation } from './core/conversation/Conversation.js';
import { createProvider, resolveModel, unlistedModelWarning } from './llm/ProviderFactory.js';
import { JsonlAuditLog } from './logging/JsonlAuditLog.js';
import type { Approver } from './permissions/Approver.js';
import { MODE_DESCRIPTIONS, PERMISSION_MODES } from './permissions/PermissionMode.js';
import { PermissionRules } from './permissions/PermissionRules.js';
import { PolicyPermissionGate } from './permissions/PolicyPermissionGate.js';
import { initProject } from './project/ProjectInit.js';
import { loadProjectInstructions } from './project/ProjectInstructions.js';
import { SessionStore, sessionTitle } from './sessions/SessionStore.js';
import { NodeShell } from './shell/NodeShell.js';
import { EditFileTool } from './tools/fs/EditFileTool.js';
import { ListDirectoryTool } from './tools/fs/ListDirectoryTool.js';
import { ReadFileTool } from './tools/fs/ReadFileTool.js';
import { WriteFileTool } from './tools/fs/WriteFileTool.js';
import { GlobTool } from './tools/search/GlobTool.js';
import { GrepTool } from './tools/search/GrepTool.js';
import { RunCommandTool } from './tools/shell/RunCommandTool.js';
import { ToolExecutor } from './tools/ToolExecutor.js';
import { ToolRegistry } from './tools/ToolRegistry.js';
import { ChatRepl } from './ui/ChatRepl.js';
import { JsonOutput } from './ui/JsonOutput.js';
import type { SessionControls } from './ui/slash-commands/SlashCommand.js';
import { BUILTIN_COMMANDS } from './ui/slash-commands/builtins.js';
import { SlashCommandRegistry } from './ui/slash-commands/SlashCommandRegistry.js';
import { formatTokens } from './ui/render/TurnRenderer.js';
import { TerminalUI } from './ui/TerminalUI.js';
import type { OutputSink } from './ui/UserInterface.js';
import { VERSION } from './version.js';
import { CheckpointStore } from './workspace/CheckpointStore.js';
import { FileReadTracker } from './workspace/FileReadTracker.js';
import { Workspace } from './workspace/Workspace.js';
import { WorkspaceWriter } from './workspace/WorkspaceWriter.js';

/**
 * COMPOSITION ROOT: the only place that knows the concrete classes and wires
 * them together. Everything else depends on interfaces. Want a different UI,
 * provider, tool set or config source? Change this file, and only this file.
 */

/** The folder heph works in (and the ONLY folder its tools can access). */
function resolveWorkspaceRoot(options: GlobalOptions): string {
  const root = path.resolve(options.cwd ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new ConfigError(
      `Workspace folder not found: ${root}`,
      'Pass an existing folder with --cwd.',
    );
  }
  return root;
}

function load(options: GlobalOptions, cwd: string): LoadedConfig {
  const flags: CliFlags = {
    ...(options.profile !== undefined && { profile: options.profile }),
    ...(options.model !== undefined && { model: options.model }),
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    ...(options.mode !== undefined && { mode: options.mode }),
    ...(options.reads !== undefined && { reads: options.reads }),
  };
  return loadConfig({ homeDir: os.homedir(), cwd, env: process.env, flags });
}

/** What both `heph` (chat) and `heph run` need: an agent with tools, permissions and logging. */
interface AgentSession {
  readonly agent: Agent;
  readonly gate: PolicyPermissionGate;
  readonly controls: SessionControls;
  readonly config: LoadedConfig;
  readonly model: string;
  readonly workspace: Workspace;
  readonly shellName: string;
  readonly instructionsFile: string | undefined;
  readonly tools: readonly { readonly name: string; readonly risk: 'read' | 'write' | 'execute' }[];
  readonly conversation: Conversation;
  readonly contextWindow: number;
  readonly contextSource: 'config' | 'detected' | 'default';
}

async function createAgentSession(
  options: GlobalOptions,
  io: {
    readonly approver: Approver;
    readonly output: OutputSink;
    readonly onProgress?: (callId: string, text: string) => void;
  },
): Promise<AgentSession> {
  const root = resolveWorkspaceRoot(options);
  const config = load(options, root);
  config.warnings.forEach((w) => io.output.warn(w));

  const provider = createProvider(config.profile);
  const model = await resolveModel(provider, config.profile.model);
  const modelWarning = await unlistedModelWarning(provider, config.profile.model);
  if (modelWarning) io.output.warn(modelWarning);

  const workspace = Workspace.open(root);
  const reads = new FileReadTracker();
  const checkpoints = new CheckpointStore();
  const writer = new WorkspaceWriter(workspace, checkpoints, reads);
  const shell = new NodeShell();
  const gate = new PolicyPermissionGate(
    io.approver,
    config.mode,
    new PermissionRules(config.rules),
    config.reads,
  );
  const audit = new JsonlAuditLog(workspace.root, (error) =>
    io.output.warn(`Audit log disabled: ${(error as Error).message}`),
  );

  // Read tools get only the read-only Workspace (via context). Write/execute tools
  // get their extra power (writer, shell) through their constructor.
  const registry = new ToolRegistry()
    .register(new ListDirectoryTool())
    .register(new ReadFileTool(reads))
    .register(new GlobTool())
    .register(new GrepTool())
    .register(new EditFileTool(writer))
    .register(new WriteFileTool(writer))
    .register(new RunCommandTool(shell));
  const executor = new ToolExecutor(registry, workspace, {
    gate,
    audit,
    sessionId: `${new Date().toISOString().slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`,
    ...(io.onProgress && { onProgress: io.onProgress }),
  });

  const instructions = loadProjectInstructions(workspace.root);
  if (instructions?.truncated) {
    io.output.warn(`${instructions.file} is very long; only the first 20,000 characters are used.`);
  }

  // Context window: config > what the server reports (LM Studio) > a safe default.
  const detected = config.profile.contextWindow ? undefined : await provider.contextWindow?.(model);
  const contextWindow =
    config.profile.contextWindow ??
    detected ??
    (isLocalUrl(config.profile.baseURL) ? 16_384 : 128_000);
  const contextSource = config.profile.contextWindow ? 'config' : detected ? 'detected' : 'default';

  // The summariser must use the CURRENT model (it can change with /model), so it reads it lazily.
  const ref: { agent?: Agent } = {};
  const context = new ContextManager({
    estimator: new TokenEstimator(),
    contextWindow,
    summarize: createLlmSummarizer(provider, () => ref.agent?.model ?? model),
  });

  const conversation = new Conversation(
    buildSystemPrompt({
      os: `${os.type()} ${os.release()} (${process.platform})`,
      shell: shell.name,
      cwd: workspace.root,
      date: new Date().toISOString().slice(0, 10),
      model,
      tools: registry.names(),
      mode: config.mode,
      ...(instructions && { projectInstructions: instructions }),
    }),
  );

  const agent = new Agent({
    provider,
    model,
    tools: executor,
    conversation,
    context,
    ...(config.profile.temperature !== undefined && { temperature: config.profile.temperature }),
  });
  ref.agent = agent;

  const controls: SessionControls = {
    get mode() {
      return gate.mode;
    },
    setMode: (m) => gate.setMode(m),
    get reads() {
      return gate.reads;
    },
    get sessionGrants() {
      return gate.sessionGrants;
    },
    clearSessionGrants: () => gate.clearSessionGrants(),
    undo: async () => {
      const result = await checkpoints.undoLast();
      if (!result) return undefined;
      return result.action === 'deleted'
        ? `deleted ${result.relative} (it was created by ${result.toolName})`
        : `restored ${result.relative} to its state before ${result.toolName}`;
    },
  };

  return {
    agent,
    gate,
    controls,
    config,
    model,
    workspace,
    shellName: shell.name,
    instructionsFile: instructions?.file,
    tools: registry.names().map((name) => ({ name, risk: registry.get(name)?.risk ?? 'read' })),
    conversation,
    contextWindow,
    contextSource,
  };
}

function isLocalUrl(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function withContext(context: string | undefined): { context?: string } {
  return context ? { context } : {};
}

/** "ctx 12%" for the input box. */
function contextPercent(agent: Agent): string | undefined {
  const usage = agent.contextUsage();
  return usage ? `ctx ${Math.round(usage.ratio * 100)}%` : undefined;
}

// ── heph (interactive chat) ──────────────────────────────────────────────────

/** `ui` is injectable so the whole app can be driven by a simulated terminal in tests. */
export async function startChat(
  options: ChatOptions,
  ui: TerminalUI = new TerminalUI(),
): Promise<void> {
  try {
    const s = await createAgentSession(options, {
      approver: ui,
      output: ui,
      onProgress: (callId, text) => ui.toolProgress(callId, text),
    });

    // Sessions: resume an earlier one (-c / --resume), and autosave after every turn.
    const store = new SessionStore(s.workspace.root);
    let sessionId = SessionStore.newId();
    let createdAt = new Date().toISOString();
    let title: string | undefined; // fixed at the first save, so compaction never renames the session
    let resumedNote: string | undefined;
    if (options.continue || options.resume) {
      const saved = options.resume ? store.load(options.resume) : store.latest();
      if (!saved) {
        ui.warn(
          options.resume
            ? `No saved session "${options.resume}". Starting fresh.`
            : 'No earlier session in this folder. Starting fresh.',
        );
      } else {
        s.conversation.restore(saved.messages);
        sessionId = saved.id;
        createdAt = saved.createdAt;
        title = saved.title;
        resumedNote = `↻ resumed "${saved.title}" · ${saved.messages.length} messages · last active ${saved.updatedAt.slice(0, 16).replace('T', ' ')}`;
        s.agent.addNote(
          'This session was resumed. Files may have changed since: re-read before editing.',
        );
      }
    }
    const autosave = () => {
      const history = s.conversation.history();
      if (history.length === 0) {
        sessionId = SessionStore.newId(); // after /clear: the next messages are a new session
        createdAt = new Date().toISOString();
        title = undefined;
        return;
      }
      try {
        store.save({
          id: sessionId,
          title: (title ??= sessionTitle(history)),
          createdAt,
          updatedAt: new Date().toISOString(),
          model: s.agent.model,
          messages: history,
        });
      } catch (error) {
        ui.warn(`Could not save the session: ${(error as Error).message}`);
      }
    };

    ui.setStatus(() => ({
      mode: s.gate.mode,
      model: s.agent.model,
      ...withContext(contextPercent(s.agent)),
    }));
    ui.setCompletions(
      BUILTIN_COMMANDS.map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.usage && { usage: c.usage }),
        ...(c.name === 'mode' && {
          args: PERMISSION_MODES.map((m) => ({ value: m, description: MODE_DESCRIPTIONS[m] })),
        }),
      })),
    );
    ui.banner({
      version: VERSION,
      profile: s.config.profile.name,
      model: s.model,
      baseURL: s.config.profile.baseURL,
      workspace: s.workspace.root,
      mode: s.config.mode,
      reads: s.config.reads,
      shell: s.shellName,
      tools: s.tools,
      context: `${formatTokens(s.contextWindow)} tokens (${s.contextSource})`,
      ...(s.instructionsFile && { instructions: s.instructionsFile }),
    });
    if (resumedNote) ui.info(resumedNote);
    await new ChatRepl({
      agent: s.agent,
      input: ui,
      output: ui,
      interrupts: ui,
      commands: new SlashCommandRegistry(BUILTIN_COMMANDS),
      session: s.controls,
      afterEach: autosave,
    }).run();
  } finally {
    ui.close();
  }
}

// ── heph run "<task>" (one shot) ─────────────────────────────────────────────

/** Exit codes of `heph run`, so scripts and CI can react. */
export const EXIT = { ok: 0, error: 1, stopped: 2, interrupted: 130 } as const;

async function runOnce(task: string, options: RunOptions): Promise<number> {
  const piped = await readPipedStdin();
  const message = piped
    ? `${task}\n\nInput piped to heph:\n<stdin>\n${piped.text}\n</stdin>${piped.truncated ? '\n(input truncated)' : ''}`
    : task;

  const json = options.json ? new JsonOutput((line) => process.stdout.write(line)) : undefined;
  const ui = json ? undefined : new TerminalUI();
  const output: OutputSink = json ?? ui!;
  const approver: Approver = json ?? ui!;

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const stopListening = ui?.onInterrupt(() => controller.abort());

  try {
    const s = await createAgentSession(options, {
      approver,
      output,
      ...(ui && { onProgress: (callId: string, text: string) => ui.toolProgress(callId, text) }),
    });
    ui?.setStatus(() => ({ mode: s.gate.mode, model: s.agent.model }));
    json?.emit({ type: 'start', model: s.model, mode: s.config.mode, workspace: s.workspace.root });
    ui?.showUserMessage(piped ? `${task}  (+ ${piped.lines} lines of piped input)` : task);

    let exitCode: number = EXIT.ok;
    let answer = '';
    for await (const event of s.agent.runTurn(
      message,
      controller.signal,
    ) as AsyncIterable<AgentEvent>) {
      output.render(event);
      if (event.type === 'text') answer += event.delta;
      if (event.type === 'error') exitCode = EXIT.error;
      if (event.type === 'interrupted') exitCode = EXIT.interrupted;
      if (event.type === 'warning' && exitCode === EXIT.ok) exitCode = EXIT.stopped;
    }
    json?.emit({ type: 'result', exitCode, answer });
    return exitCode;
  } catch (error) {
    if (!json) throw error; // the CLI entry point prints it nicely
    json.error(error);
    json.emit({ type: 'result', exitCode: EXIT.error, answer: '' });
    return EXIT.error;
  } finally {
    process.off('SIGINT', onSigint);
    stopListening?.();
    ui?.close();
  }
}

/**
 * `cat file | heph run "…"`: read what was piped in. Waits briefly when stdin is
 * not a terminal but nothing arrives (CI jobs often leave stdin open and empty).
 */
async function readPipedStdin(): Promise<
  { text: string; lines: number; truncated: boolean } | undefined
> {
  if (process.stdin.isTTY) return undefined;
  const MAX = 200_000;
  return new Promise((resolve) => {
    let data = '';
    let received = false;
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.off('end', finish);
      process.stdin.pause();
      clearTimeout(idle);
      const text = data.trim();
      resolve(
        text
          ? {
              text: text.slice(0, MAX),
              lines: text.split('\n').length,
              truncated: text.length > MAX,
            }
          : undefined,
      );
    };
    const onData = (chunk: Buffer) => {
      received = true;
      data += chunk.toString('utf8');
      if (data.length > MAX * 2) finish();
    };
    const idle = setTimeout(() => {
      if (!received) finish();
    }, 1500);
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
  });
}

// ── heph init ────────────────────────────────────────────────────────────────

async function init(options: GlobalOptions & { readonly force?: boolean }): Promise<void> {
  const root = resolveWorkspaceRoot(options);
  const result = initProject(root, { force: options.force ?? false });
  console.log(chalk.bold(`\nheph init in ${root}\n`));
  for (const file of result.created) console.log(`  ${chalk.green('✓ created')}  ${file}`);
  for (const file of result.skipped) {
    console.log(
      `  ${chalk.yellow('• exists ')}  ${file} ${chalk.dim('(kept; use --force to overwrite)')}`,
    );
  }
  if (result.detected.length) {
    console.log(chalk.dim(`\n  Detected commands: ${result.detected.join(', ')}`));
  }
  console.log(
    `\n  Next: edit ${chalk.cyan('HEPH.md')} to describe your project and conventions. heph reads it at every start.\n`,
  );
}

// ── heph config ──────────────────────────────────────────────────────────────

async function showConfig(options: GlobalOptions): Promise<void> {
  const root = resolveWorkspaceRoot(options);
  const c = load(options, root);
  const key = c.profile.apiKey;
  const masked =
    key.length > 12 ? `${key.slice(0, 3)}…${key.slice(-4)}` : key === 'lm-studio' ? key : '••••';
  const instructions = loadProjectInstructions(root);
  const row = (k: string, v: string) => console.log(`  ${chalk.dim(k.padEnd(14))} ${v}`);

  console.log(chalk.bold('\nheph configuration\n'));
  row('workspace', root);
  row('profile', `${c.profile.name}  ${chalk.dim(c.profile.baseURL)}`);
  row('model', c.profile.model);
  row('api key', masked);
  row('mode', `${c.mode}  ${chalk.dim(MODE_DESCRIPTIONS[c.mode])}`);
  row('reads', c.reads);
  row('allow rules', c.rules.allow.length ? c.rules.allow.join(', ') : chalk.dim('none'));
  row('deny rules', c.rules.deny.length ? c.rules.deny.join(', ') : chalk.dim('none'));
  row('instructions', instructions ? instructions.file : chalk.dim('none (run `heph init`)'));
  row('audit log', path.join(root, '.heph', 'logs'));
  console.log(chalk.bold('\n  config files (lowest → highest priority)'));
  for (const file of [userConfigPath(os.homedir()), projectConfigPath(root)]) {
    const used = c.files.includes(file);
    console.log(
      `  ${used ? chalk.green('✓') : chalk.dim('·')} ${used ? file : chalk.dim(`${file} (not found)`)}`,
    );
  }
  console.log(
    chalk.dim('    then env vars (HEPH_PROFILE, HEPH_MODEL, HEPH_MODE, HEPH_READS…), then flags'),
  );
  for (const w of c.warnings) console.log(chalk.yellow(`\n  ⚠ ${w}`));
  console.log('');
}

// ── heph sessions ────────────────────────────────────────────────────────────

async function listSessions(options: GlobalOptions): Promise<void> {
  const root = resolveWorkspaceRoot(options);
  const sessions = new SessionStore(root).list();
  if (sessions.length === 0) {
    console.log(
      chalk.dim(
        '\nNo saved sessions in this folder yet. They are saved automatically while you chat.\n',
      ),
    );
    return;
  }
  console.log(chalk.bold(`\nSaved sessions in ${root}\n`));
  for (const [i, s] of sessions.slice(0, 20).entries()) {
    const when = s.updatedAt.slice(0, 16).replace('T', ' ');
    console.log(
      `  ${chalk.cyan(s.id)}  ${chalk.dim(when)}  ${chalk.dim(`${String(s.messageCount).padStart(3)} msgs`)}  ${s.title}${i === 0 ? chalk.green('  ← heph -c') : ''}`,
    );
  }
  console.log(
    chalk.dim(`\n  Continue the latest: heph -c   ·   a specific one: heph --resume <id>\n`),
  );
}

// ── heph models ──────────────────────────────────────────────────────────────

async function listModels(options: GlobalOptions): Promise<void> {
  const { profile } = load(options, resolveWorkspaceRoot(options));
  const models = await createProvider(profile).listModels();
  console.log(chalk.dim(`Models on profile "${profile.name}" (${profile.baseURL}):`));
  for (const id of models) {
    const selected = id === profile.model ? chalk.green('  ← selected') : '';
    console.log(`  ${id}${selected}`);
  }
  if (profile.model === 'auto') {
    console.log(chalk.dim('\nmodel is "auto": the first chat model is used.'));
  }
}

export const cliActions: CliActions = {
  chat: startChat,
  models: listModels,
  run: runOnce,
  init,
  config: showConfig,
  sessions: listSessions,
};
