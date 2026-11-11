# heph — Technical Design Document

Companion to [01-PRD.md](./01-PRD.md). This document covers **what we build with**, **how the pieces fit**, **how tools work**, **how permissions protect the user**, and **how to run and test everything locally**.

---

## 1. Technology choices

| Concern | Choice | Why |
|---------|--------|-----|
| Language | **TypeScript 5 (strict)** | Types make interfaces explicit, which is essential for practising SOLID. Huge ecosystem for CLIs. |
| Runtime | **Node.js ≥ 20 LTS** | Ships everywhere. `npm i -g` gives users a one-command install. |
| Package manager | **npm** (ships with Node) | Zero extra installs for contributors. pnpm works too if you prefer it. |
| LLM client | **`openai`** official SDK | Works with OpenAI **and** LM Studio, Ollama and vLLM through `baseURL`. One client, many backends. |
| CLI parsing | **`commander`** | Simple, well-documented subcommands and flags. |
| Terminal UX | **`chalk`** (colour), **`ora`** (spinner), **`@inquirer/prompts`** (approval prompts), **`marked` + `marked-terminal`** (render markdown) | Small, composable libraries. Upgrade to **Ink** (React for CLIs) later as a learning exercise. |
| Validation | **`zod`** + **`zod-to-json-schema`** | One schema per tool provides runtime validation of LLM arguments **and** the JSON Schema sent to the model. |
| Diffs | **`diff`** (jsdiff) | Builds unified diffs for the approval preview. |
| File search | **`fast-glob`**, **`ignore`** (gitignore rules) | Cross-platform globbing that respects `.gitignore`. |
| Shell | **`execa`** | Cross-platform process spawning with timeouts and cancellation. |
| Config | JSON files + zod schema, with env-var overrides | Transparent and easy to debug. |
| Tokens | **`js-tiktoken`** (estimation) | Context budgeting. Local models use different tokenizers, so treat counts as estimates. |
| Testing | **Vitest** (unit/integration), **memfs** or temp dirs (filesystem), **msw** (HTTP mocking) | Fast, TS-native. |
| Build | **tsup** (esbuild) | Bundles to one ESM file with a `#!/usr/bin/env node` shebang. |
| Quality | ESLint, Prettier, Husky + lint-staged | Consistent code for contributors. |
| CI/CD | **GitHub Actions** (lint, test on a Win/macOS/Linux matrix, publish on tag), **Changesets** | Professional OSS release flow. |

> **Local LLM:** **LM Studio** exposes an OpenAI-compatible server at `http://localhost:1234/v1`. Our code cannot tell it apart from OpenAI. That is the point of the design.

---

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Presentation layer   cli/ (commander)      ui/ (TerminalUI)      │
└───────────────┬──────────────────────────────────▲───────────────┘
                │ user input                       │ events (text, tool calls, diffs)
┌───────────────▼──────────────────────────────────┴───────────────┐
│ Core (application) layer                                         │
│   Agent ── runs the loop ──►  Conversation (message history)     │
│     │                         ContextManager (token budget)      │
│     ├──► LLMProvider (interface)                                 │
│     ├──► ToolRegistry ──► Tool (interface)                       │
│     └──► PermissionGate (interface) ──► Approver (asks the UI)   │
└───────────────┬──────────────────────────────────────────────────┘
                │ depends only on interfaces
┌───────────────▼──────────────────────────────────────────────────┐
│ Infrastructure layer                                             │
│   OpenAICompatibleProvider · NodeFileSystem · PathGuard          │
│   ExecaShell · JsonConfigStore · CheckpointStore · AuditLogger   │
└──────────────────────────────────────────────────────────────────┘
   container.ts (composition root) wires concrete classes to interfaces
```

**Dependency rule:** arrows point inward. `core/` never imports `openai`, `fs`, `execa` or `chalk`. It only knows interfaces. That makes the core testable with fakes and lets you swap any infrastructure piece.

---

## 3. Project folder layout

```
heph/
├── src/
│   ├── cli/                         # PRESENTATION: argument parsing only
│   │   ├── index.ts                 # entry point (bin), registers commands
│   │   └── commands/
│   │       ├── chat.command.ts      # `heph` (REPL)
│   │       ├── run.command.ts       # `heph run "<task>"`
│   │       ├── init.command.ts
│   │       └── config.command.ts
│   │
│   ├── ui/                          # PRESENTATION: everything that prints or prompts
│   │   ├── UserInterface.ts         # interface (output + input)
│   │   ├── TerminalUI.ts            # chalk/ora/inquirer implementation
│   │   ├── DiffRenderer.ts
│   │   ├── MarkdownRenderer.ts
│   │   └── slash-commands/          # /help, /undo, /mode … (one file each)
│   │
│   ├── core/                        # APPLICATION: no I/O libraries here
│   │   ├── agent/
│   │   │   ├── Agent.ts             # the agent loop
│   │   │   ├── AgentEvents.ts       # typed event definitions
│   │   │   └── AgentOptions.ts
│   │   ├── conversation/
│   │   │   ├── Conversation.ts      # message history
│   │   │   └── Message.ts           # provider-neutral message types
│   │   ├── context/
│   │   │   ├── ContextManager.ts    # token budget, truncation, summarisation
│   │   │   └── SystemPromptBuilder.ts
│   │   └── errors/                  # domain errors (ToolError, PermissionDenied…)
│   │
│   ├── llm/                         # LLM abstraction + implementations
│   │   ├── LLMProvider.ts           # interface
│   │   ├── ProviderFactory.ts       # profile → provider
│   │   ├── openai-compatible/
│   │   │   ├── OpenAICompatibleProvider.ts
│   │   │   └── mappers.ts           # our Message ⇄ OpenAI format
│   │   └── fake/
│   │       └── ScriptedProvider.ts  # deterministic provider for tests
│   │
│   ├── tools/
│   │   ├── Tool.ts                  # interface + ToolResult + RiskLevel
│   │   ├── ToolRegistry.ts
│   │   ├── ToolExecutor.ts          # validate → permission → execute → format
│   │   ├── fs/                      # one class per file
│   │   │   ├── ListDirectoryTool.ts
│   │   │   ├── ReadFileTool.ts
│   │   │   ├── WriteFileTool.ts
│   │   │   └── EditFileTool.ts
│   │   ├── search/
│   │   │   ├── GlobTool.ts
│   │   │   └── GrepTool.ts
│   │   └── shell/
│   │       ├── RunCommandTool.ts
│   │       └── DangerousCommandDetector.ts
│   │
│   ├── permissions/
│   │   ├── PermissionGate.ts        # interface
│   │   ├── PermissionMode.ts        # read-only | ask | auto-edit | full-auto
│   │   ├── PolicyPermissionGate.ts  # decides allow / deny / ask
│   │   ├── SessionGrants.ts         # "always allow this session"
│   │   └── Approver.ts              # interface: asks a human (UI implements it)
│   │
│   ├── workspace/
│   │   ├── FileSystem.ts            # interface
│   │   ├── NodeFileSystem.ts        # real fs implementation
│   │   ├── PathGuard.ts             # keeps every path inside the workspace
│   │   ├── IgnoreRules.ts           # .gitignore + built-in deny list
│   │   └── CheckpointStore.ts       # backups for /undo
│   │
│   ├── shell/
│   │   ├── Shell.ts                 # interface
│   │   └── ExecaShell.ts
│   │
│   ├── config/
│   │   ├── ConfigSchema.ts          # zod schema + defaults
│   │   ├── ConfigLoader.ts          # merge: defaults < user < project < env < flags
│   │   └── paths.ts                 # ~/.heph, ./.heph
│   │
│   ├── logging/
│   │   ├── Logger.ts                # interface
│   │   └── AuditLogger.ts           # JSONL log of every tool call + decision
│   │
│   └── container.ts                 # COMPOSITION ROOT: the only place using `new` on infra
│
├── tests/
│   ├── unit/                        # mirrors src/
│   ├── integration/                 # Agent + real tools + ScriptedProvider in temp dirs
│   ├── e2e/                         # spawn the built CLI; optional LM Studio suite
│   └── fixtures/sample-project/
│
├── docs/                            # PRD, design, roadmap, learning-notes/
├── .github/workflows/ci.yml, release.yml
├── package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
├── README.md  CONTRIBUTING.md  SECURITY.md  CHANGELOG.md  LICENSE
└── HEPH.md                    # dog-fooding: rules for the agent itself
```

**Naming conventions:** `PascalCase.ts` for classes and interfaces, `kebab.command.ts` for CLI commands, one public class per file, and test files named `X.test.ts` in the mirrored folder.

---

## 4. SOLID, applied concretely

| Principle | Where it shows up | Test of the principle |
|-----------|-------------------|-----------------------|
| **S**ingle Responsibility | `Agent` only runs the loop. `ToolExecutor` only validates, checks permission and executes. `PathGuard` only resolves and validates paths. `DiffRenderer` only formats diffs. | Each class can be described in one sentence without "and". |
| **O**pen/Closed | New tools are added by **registering** a new class implementing `Tool`. New providers come from implementing `LLMProvider`. New slash commands are new files. | Adding `WebFetchTool` touches **zero** existing classes (only `container.ts`). |
| **L**iskov Substitution | `ScriptedProvider`, `OpenAICompatibleProvider` and a future `AnthropicProvider` are interchangeable. `InMemoryFileSystem` substitutes for `NodeFileSystem` in tests. | The same contract test suite runs against every implementation. |
| **I**nterface Segregation | `UserInterface` is split into `OutputSink` (render events) and `Approver` (ask a yes/no question). `FileSystem` is split into `FileReader` and `FileWriter`, so read tools cannot receive a writer at all. | A read-only tool's constructor **cannot** receive a `FileWriter`. |
| **D**ependency Inversion | `Agent` depends on `LLMProvider`, `ToolRegistry` and `PermissionGate` interfaces. Concrete classes are injected in `container.ts`. | `core/` has no imports from `openai`, `node:fs`, `execa` or `chalk`. An ESLint `no-restricted-imports` rule enforces this. |

---

## 5. Core logic

### 5.1 Key interfaces

```ts
// llm/LLMProvider.ts
export interface LLMProvider {
  readonly name: string;
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}
export interface ChatRequest {
  model: string;
  messages: Message[];          // provider-neutral (core/conversation/Message.ts)
  tools: ToolDefinition[];      // { name, description, parameters: JSONSchema }
  temperature?: number;
}
export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; argumentsJson: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } };
```

```ts
// tools/Tool.ts
export type RiskLevel = 'read' | 'write' | 'execute';

export interface Tool<TArgs = unknown> {
  readonly name: string;                 // snake_case, shown to the LLM
  readonly description: string;          // tell the model WHEN and HOW to use it
  readonly schema: z.ZodType<TArgs>;     // validates the LLM's arguments
  readonly risk: RiskLevel;
  /** Describe the effect BEFORE running, for the approval prompt (diff, command…) */
  preview(args: TArgs, ctx: ToolContext): Promise<ActionPreview>;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
export interface ToolResult { ok: boolean; output: string; meta?: Record<string, unknown> }
export type ActionPreview =
  | { kind: 'none' }
  | { kind: 'diff'; path: string; unifiedDiff: string; isNewFile: boolean }
  | { kind: 'command'; command: string; cwd: string; warnings: string[] };
```

```ts
// permissions/PermissionGate.ts
export type Decision =
  | { verdict: 'allow' }
  | { verdict: 'deny'; reason: string; feedback?: string };

export interface PermissionGate {
  check(tool: Tool, args: unknown, preview: ActionPreview): Promise<Decision>;
}
```

### 5.2 The agent loop

This is the heart of every coding agent. It is about 60 lines. Write it yourself in Milestone 2.

```ts
// core/agent/Agent.ts (simplified)
async runTurn(userInput: string, signal: AbortSignal) {
  this.conversation.addUser(userInput);

  for (let i = 0; i < this.options.maxIterations; i++) {
    const messages = this.context.fit(this.conversation.messages()); // stay under token budget
    const { text, toolCalls } = await this.streamFromLLM(messages, signal); // emits 'text' events

    this.conversation.addAssistant(text, toolCalls);
    if (toolCalls.length === 0) return;               // model is done → wait for the user

    for (const call of toolCalls) {                    // run sequentially: simpler, safer
      const result = await this.toolExecutor.run(call, signal);
      this.conversation.addToolResult(call.id, result); // ALWAYS answer every tool_call id
    }
  }
  this.events.emit('warning', 'Max iterations reached, stopping.');
}
```

```
User ──► [Conversation] ──► LLM ──► text only? ──yes──► show answer, wait for user
                             ▲            │ no (tool_calls)
                             │            ▼
                             │      ToolExecutor: validate → preview → permission → execute
                             └────── tool results appended to Conversation
```

### 5.3 `ToolExecutor` pipeline (one responsibility per step)

1. **Look up** the tool in `ToolRegistry`. If it is unknown, return an error result ("Unknown tool X. Available: …") so the model can correct itself.
2. **Parse** `argumentsJson`, then **validate** with `tool.schema.safeParse`. On failure, return the zod error message to the model as the tool result. Small local models need this feedback loop.
3. **Preview**: call `tool.preview(args)` to get the diff or command.
4. **Permission**: call `PermissionGate.check(tool, args, preview)`. If denied, return `"User denied this action. Reason/feedback: …"`.
5. **Execute** with a timeout and the abort signal.
6. **Format**: truncate output (e.g. 20k characters; keep the head and tail, add "[… truncated N lines …]").
7. **Audit**: write a JSONL line to `.heph/logs/audit-YYYY-MM-DD.jsonl`.

Errors thrown by a tool are **caught and turned into `ToolResult{ok:false}`**. A tool failure must never crash the agent; the model sees the error and tries something else.

### 5.4 How each tool works

| Tool | Arguments (zod) | Logic | Gotchas you will learn |
|------|----------------|-------|------------------------|
| `list_directory` | `path`, `depth?` (default 2) | `PathGuard.resolve`, then walk the tree while filtering with `IgnoreRules`, and return an indented tree with `/` on folders | Skip `node_modules`, `.git` and binaries. Cap at about 500 entries. |
| `read_file` | `path`, `startLine?`, `endLine?` | Resolve and guard the path, reject files over 1 MB or binary files (check for NUL bytes), and return content **with line numbers** | Line numbers help the model reference code. Record `ctx.readFiles.add(path)` (used by edit). |
| `glob` | `pattern`, `path?` | `fast-glob` with ignore rules, sorted by modification time, capped at 200 | Normalise `\` to `/` on Windows. |
| `grep` | `pattern` (regex), `path?`, `include?` (glob), `caseInsensitive?` | Stream files, test each line, return `file:line: text`, capped | Use `ripgrep` when it is installed (faster) and fall back to JS. That is a nice Strategy-pattern exercise. |
| `write_file` | `path`, `content` | **preview:** read the old content (or empty), build a unified diff · **execute:** checkpoint the old version, create parent dirs, write the file | If the file exists and the model never read it, refuse ("read it first"). That prevents blind overwrites. |
| `edit_file` | `path`, `oldText`, `newText`, `replaceAll?` | Requires the file to have been read this session. `oldText` must occur **exactly once** (unless `replaceAll`). Otherwise return an error with the match count. Diff preview, checkpoint, then write. | Why not line numbers? They drift after every edit. Why not rewrite the whole file? Slow, costly, and models silently drop code. Exact-match replacement is what production agents use. Preserve CRLF/LF line endings. |
| `run_command` | `command`, `cwd?`, `timeoutMs?` (default 120000) | **preview:** the command plus warnings from `DangerousCommandDetector` · **execute:** `execa` through the platform shell (PowerShell on Windows, `sh` elsewhere), capture stdout/stderr/exit code, kill on timeout or abort | Never auto-approve in `ask` mode. Truncate output. Set `cwd` inside the workspace only. Strip ANSI codes. |

**Writing good tool descriptions is half the work.** The model only "sees" the name, description and schema. Example:
> `edit_file`: "Replace an exact snippet of text in a file. You MUST call read_file on the file first. `oldText` must match the file exactly, including whitespace, and must be unique; include surrounding lines to make it unique. Prefer this over write_file for changes to existing files."

### 5.5 System prompt (`SystemPromptBuilder`)
Built from parts (also Open/Closed):
1. Identity and rules ("You are heph, a careful coding agent… Read before you edit… Make minimal changes… Explain what you changed").
2. Environment: OS, shell, workspace root, date, git status if available.
3. Current permission mode, so the model knows it may be denied.
4. Project instructions from `HEPH.md` (or `AGENTS.md`) if present.

### 5.6 Context management (Milestone 6)
- Estimate tokens for each message. Keep `system + last N turns` under `contextWindow - reserveForOutput`.
- Strategy 1: truncate old, large tool outputs to "[output elided]".
- Strategy 2: summarise the oldest turns with an extra LLM call ("compaction").
- These are `ContextStrategy` implementations, so you can swap them (Strategy pattern again).

---

## 6. Accessing user files safely, with permission

This is the most important section for trust. There are **three layers of defence**, applied in order.

### Layer 1: Workspace boundary (`PathGuard`), always on, in every mode
```ts
resolve(userPath: string): string {
  const abs = path.resolve(this.root, userPath);            // handles relative + absolute input
  const real = fs.realpathSync.native(existingAncestor(abs)); // follows symlinks
  const rel = path.relative(this.realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathOutsideWorkspaceError(userPath);
  }
  return abs;
}
```
- The workspace root is the folder where `heph` was started, or the git root if the user passes `--git-root`.
- Paths on Windows are case-insensitive. Compare with `toLowerCase()` there, and test it.
- **Deny list** (`IgnoreRules`): `.git/**`, `.env*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, `.heph/checkpoints/**`. Reads of these are denied by default, and the user can explicitly allow a path in config.
- The shell tool cannot be fully confined by path checks (a command can `cd ..`). That is why it is **always** `execute` risk and always prompts in `ask` mode. Real sandboxing (Docker, OS sandboxes) is a stretch milestone.

### Layer 2: Permission modes (`PolicyPermissionGate`)

| Mode | read | write | execute | Use case |
|------|------|-------|---------|----------|
| `read-only` | ✅ auto | ❌ denied | ❌ denied | Exploring and asking questions ("plan mode") |
| **`ask` (default)** | ✅ auto | ❓ prompt | ❓ prompt | Normal work |
| `auto-edit` | ✅ auto | ✅ auto (diff still printed) | ❓ prompt | Trusted refactors |
| `full-auto` | ✅ auto | ✅ auto | ✅ auto, except dangerous patterns, which still prompt | Throw-away sandboxes. Requires the `--yes-i-understand` flag. |

Decision order inside `check()`:
```
1. PathGuard / deny list violation       → DENY (no override)
2. mode forbids this risk level          → DENY
3. config rule matches (allow/deny list, e.g. allow "npm test", deny "git push*")
4. SessionGrants has "always allow" for this tool (+ command prefix for shell)  → ALLOW
5. mode auto-allows this risk level      → ALLOW
6. otherwise                             → ask Approver (the human)
```

### Layer 3: Human approval (`Approver`, implemented by `TerminalUI`)
```
╭─ heph wants to edit src/utils/math.ts ───────────────╮
│ @@ -10,3 +10,7 @@                                           │
│  export function add(a: number, b: number) {                │
│    return a + b;                                            │
│  }                                                          │
│ +export function multiply(a: number, b: number) {           │
│ +  return a * b;                                            │
│ +}                                                          │
╰─────────────────────────────────────────────────────────────╯
 Apply this change?
 ❯ Yes
   Yes, and don't ask again for edit_file this session
   No
   No, and tell heph what to do instead
```
- In non-interactive use (`heph run` with no TTY), anything that would prompt is **denied** unless the mode or config allows it. Never hang, never assume yes.
- **Ctrl+C** during a prompt equals "No" and aborts the turn.

### Safety net: checkpoints and audit
- Before any write, `CheckpointStore` copies the original into `.heph/checkpoints/<session>/<n>/`. `/undo` restores the last checkpoint, and a new file is removed on undo.
- Every tool call, preview and decision is logged in the JSONL audit log.
- `heph init` adds `.heph/` to `.gitignore`.

---

## 7. Configuration

Precedence, lowest to highest: **built-in defaults < `~/.heph/config.json` (user) < `./.heph/config.json` (project) < env vars < CLI flags**.

```jsonc
// ~/.heph/config.json
{
  "defaultProfile": "local",
  "profiles": {
    "local":  { "baseURL": "http://localhost:1234/v1", "apiKey": "lm-studio", "model": "qwen2.5-coder-7b-instruct", "contextWindow": 32768 },
    "openai": { "baseURL": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY", "model": "gpt-4o-mini", "contextWindow": 128000 }
  },
  "permissions": {
    "mode": "ask",
    "allow": ["run_command:npm test", "run_command:git status"],
    "deny":  ["run_command:git push*", "run_command:rm -rf*"]
  },
  "agent": { "maxIterations": 25, "toolOutputLimit": 20000 }
}
```
- **Security rule:** API keys are **never** read from a *project* config, because a malicious repo could redirect your key to its own server. Project config may set the model and permissions, but only to make them *stricter*, never looser.
- Model names are examples. Use whatever you have downloaded in LM Studio and whichever OpenAI model you prefer.

---

## 8. Running locally

### 8.1 Prerequisites
- Node.js ≥ 20 (`node -v`), npm (comes with Node), git.
- **LM Studio** (https://lmstudio.ai) for the free local LLM.
- Optional: an OpenAI API key.

### 8.2 Set up LM Studio as the test LLM
1. Install LM Studio and open the **Discover** tab.
2. Download a **tool-calling capable** model. Good starting points:
   - `Qwen2.5-Coder-7B-Instruct` (good balance; Q4_K_M needs about 6 GB of RAM/VRAM)
   - `Llama-3.1-8B-Instruct`
   - a larger Qwen coder model if your hardware allows
3. Go to the **Developer** tab, load the model, set the context length (e.g. 16k–32k), and click **Start Server** (port **1234**). Or use the CLI: `lms server start` and `lms load <model>`.
4. Smoke test from PowerShell:
   ```powershell
   curl.exe http://localhost:1234/v1/models
   ```
5. Use the model identifier shown in LM Studio as `model` in the `local` profile. The API key can be any non-empty string.

### 8.3 Run heph from source
```powershell
git clone https://github.com/<you>/heph.git
cd heph
npm install
npm run dev -- --help   # tsx: runs src/cli/index.ts directly, no build step
# or
npm run build            # tsup → dist/cli.js
npm link                 # now `heph` works in any folder (undo: npm unlink -g heph-cli)
cd ..\some-test-project
heph --profile local
```
For OpenAI:
```powershell
$env:OPENAI_API_KEY = "sk-..."
heph --profile openai
```

### 8.4 Suggested `package.json` scripts
```json
{
  "bin": { "heph": "dist/cli.js" },
  "scripts": {
    "dev": "tsx src/cli/index.ts",
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:llm": "vitest run tests/e2e --config vitest.llm.config.ts",
    "lint": "eslint . && prettier --check .",
    "typecheck": "tsc --noEmit"
  }
}
```

---

## 9. Testing strategy

| Level | What | How | Needs an LLM? |
|-------|------|-----|---------------|
| **Unit** | Each tool, PathGuard, PermissionGate, ConfigLoader, mappers, DiffRenderer | Vitest. Temp dirs (`fs.mkdtemp`) or an in-memory FileSystem. A `FakeApprover` returns scripted answers. | ❌ |
| **Agent loop** | Multi-step tool use, error recovery, denial handling, max iterations | **`ScriptedProvider`** replays a predefined list of responses (e.g. "call read_file → call edit_file → final text") | ❌ (deterministic) |
| **Contract** | Every `LLMProvider` and `FileSystem` implementation behaves the same | Shared test suite run against each implementation (LSP) | ❌ |
| **Provider** | OpenAI request/response mapping, streaming tool-call assembly | `msw` mocks the HTTP endpoint using recorded responses | ❌ |
| **E2E (CLI)** | Spawn `dist/cli.js` with a fake provider, feed stdin, assert stdout and files | `execa` + a fixture project | ❌ |
| **Live LLM** | Real behaviour with LM Studio | `npm run test:llm`, skipped automatically when `localhost:1234` is unreachable. Asserts **outcomes** (the file contains `multiply`), not exact text. | ✅ LM Studio |

**Must-have safety tests** (these are the PRD's G3 guarantee):
- In `ask` mode, `write_file`, `edit_file` and `run_command` with an Approver that answers "no" → the file system is unchanged and no process is spawned.
- `read_file("../outside.txt")`, an absolute path outside the root, and a symlink pointing outside → `PathOutsideWorkspaceError` in **every** mode, including `full-auto`.
- Non-TTY with no allow rule → denied, with no hang.
- `read-only` mode → write and execute are denied without asking.

Example agent-loop test:
```ts
it('asks before editing and respects "no"', async () => {
  const provider = new ScriptedProvider([
    toolCall('read_file', { path: 'a.ts' }),
    toolCall('edit_file', { path: 'a.ts', oldText: '1', newText: '2' }),
    text('I could not edit the file because you declined.'),
  ]);
  const approver = new FakeApprover(['deny']);
  const { agent, fs } = createTestAgent({ provider, approver, files: { 'a.ts': 'const x = 1;' } });

  await agent.runTurn('change 1 to 2', new AbortController().signal);

  expect(await fs.read('a.ts')).toBe('const x = 1;');
  expect(approver.asked).toHaveLength(1);
});
```

---

## 10. Open-source release

- **Licence:** MIT. Files: `README.md` (GIF demo, install, quickstart with LM Studio), `CONTRIBUTING.md` ("how to add a tool" guide, which the Open/Closed design makes short), `SECURITY.md` (threat model, the no-sandbox caveat, how to report a vulnerability), `CODE_OF_CONDUCT.md`, and issue/PR templates.
- **CI (`ci.yml`):** on each PR, run `lint`, `typecheck` and `test` on `ubuntu-latest`, `windows-latest` and `macos-latest` with Node 20 and 22.
- **Release (`release.yml`):** Changesets opens a "Version Packages" PR. Merging it publishes to npm with `--provenance` and creates a GitHub Release.
- **Install for users:** `npm install -g heph-cli`, then run `heph`. Optionally offer standalone binaries later via Node SEA or `bun build --compile`.

---

## 11. Extension points (for future you and contributors)
- **New tool:** implement `Tool`, register it in `container.ts`, and add tests. That's all.
- **New provider:** implement `LLMProvider` (e.g. a native Anthropic or Gemini API) and add a case in `ProviderFactory`.
- **MCP client:** wrap each MCP server tool as a `Tool` adapter (Adapter pattern), which gives you access to the whole MCP ecosystem.
- **Hooks:** emit `beforeToolCall` and `afterToolCall` events, so users can run a formatter or linter after edits.
