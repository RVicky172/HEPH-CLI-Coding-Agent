# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**heph** is a CLI coding agent (TypeScript, Node ≥ 20) that talks to any OpenAI-compatible API: OpenAI, or a local LLM through LM Studio. It is a **learning project** that will be released as open source (MIT, npm package `heph-cli`, command `heph`).

- The product name is **heph** only. Never write "Hephaestus" in code, docs or output. The folder name is a leftover.
- Plan and design: `docs/01-PRD.md`, `docs/02-TECHNICAL-DESIGN.md`, `docs/03-LEARNING-ROADMAP.md` (milestones M0–M7).
- Progress: M0 (setup), M1 (streaming chat), M2 (agent loop, read tools, rendered output), M3 (permission modes, edit/write with diff approval, /undo) and M4 (run_command, danger detection, allow/deny rules, themed UI, hammer spinner) (plus M4.1: UI polish, live slash suggestions, reads ask by default) are done. and M5 (`heph run`, `heph init`, `heph config`, HEPH.md instructions, audit log)., M6 (context management: fit/compaction, ctx %, /context, /compact, sessions -c/--resume). **M7 (release: README with demo, CONTRIBUTING, SECURITY, CHANGELOG, release workflow) is next.**

## Working style (learning project)

- Work **one milestone at a time**, following the roadmap. Don't jump ahead or add features from later milestones unasked.
- Explain the *why* of design decisions as you go. Code comments should teach the concept, not restate the code.
- After each milestone (or notable bug), add or update `docs/learning-notes/MXX.md`: what was built, key concepts, surprises, exercises, and a done-when checklist.
- Each milestone follows: **interface first → fake implementation + tests → real implementation → try it on LM Studio.**
- **Don't commit, push or publish.** The user commits and pushes at the end themselves. Never run `npm publish`.

## Commands

```bash
npm run dev                 # run from source (tsx), chat with LM Studio
npm run dev -- models       # list models on the selected profile
npm run check               # typecheck + lint + format:check + unit tests (same as CI)
npm test                    # unit tests only (offline, fast)
npm run test:llm            # live tests against LM Studio; auto-skipped if unreachable
npm run build               # tsup → dist/cli.js
npx prettier --write src tests   # format before running check
```

Package manager is **npm** (pnpm is not installed). Run `npm run check` before calling any change done.

## Architecture rules (SOLID, enforced)

```
cli/ (commander) → container.ts (composition root) → ui/ · core/ · llm/ · config/ · tools/ · permissions/ · workspace/
```

- **`src/core/` must not import I/O or UI libraries** (`node:*`, `fs`, `openai`, `chalk`, `commander`, …) or outer layers (`cli/`, `ui/`, `container`). ESLint enforces this in `eslint.config.js`. Pass data and interfaces in instead.
- **`src/container.ts` is the only place that instantiates concrete infrastructure** and wires it to interfaces.
- Only `src/llm/openai-compatible/` imports `openai`. The core speaks provider-neutral `Message`/`ChatChunk` types (`core/conversation/Message.ts`, `llm/LLMProvider.ts`).
- Only `src/ui/TerminalUI.ts` touches stdin/stdout; `ui/render/TurnRenderer.ts` turns AgentEvents into text (testable). UI interfaces are segregated: `InputSource`, `OutputSink`, `InterruptSource` (M3 adds `Approver`).
- Tools reach files ONLY through `workspace/Workspace.ts` (PathGuard + IgnoreRules). It has no write methods; M3 adds a separate writer for write tools only.
- The Agent depends on the `ToolRunner` port (`core/agent/ToolRunner.ts`); `tools/ToolExecutor.ts` implements it and never throws.
- Extension = add a class and register it (Open/Closed): tools in `ToolRegistry` (M2), slash commands in `ui/slash-commands/builtins.ts`, providers in `llm/ProviderFactory.ts`.
- Expected failures are `HephError` subclasses (`LLMError`, `ConfigError`) with a user-facing `hint`. Providers translate SDK errors into `LLMError`.
- `Agent.runTurn()` is an async generator yielding `AgentEvent`s. The agent never prints.

## Safety invariants (non-negotiable)

- No write or execute tool may run without user approval in the default `ask` mode. Every such path needs a test proving it.
- Paths must never escape the workspace root (`..`, absolute paths, symlinks), in any mode.
- **Project config (`./.heph/config.json`) may not set `baseURL`, `apiKey` or `apiKeyEnv`.** A cloned repo could otherwise steal API keys. Covered by the SECURITY test in `ConfigLoader.test.ts`.
- Never put real API keys in code, tests or docs.

## Code conventions

- TypeScript strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`:
  - Use `import type` for types. Use `.js` extensions in relative imports.
  - Don't assign `undefined` to optional props. Use conditional spreads: `...(x !== undefined && { x })`.
- Private state uses `#fields`. One public class per file, `PascalCase.ts`.
- Prettier: single quotes, trailing commas, width 100, LF. Markdown is excluded from Prettier.
- Tests mirror `src/` under `tests/unit/`. Use fakes (`ScriptedProvider`, fake terminals, injected `readFile`/clock/timers) rather than mocking libraries. The provider is tested against a real tiny `node:http` server.
- Live LLM tests (`tests/live/`) assert outcomes ("contains pong"), never exact text.

## Local environment

- Windows 11, PowerShell. Local Node is v26, but code must work on Node 20 (CI matrix: Node 20 and 22 on Windows, macOS and Linux).
- `@types/node` is pinned to 22 (Vitest 5 requires ≥ 22.12).
- LM Studio runs at `http://localhost:1234/v1` with `qwen/qwen3-30b-a3b-2507` (supports tool calling) plus an embedding model. Profile `local` with `model: "auto"` skips embedding models.
- npm 11 shows an `allow-scripts` warning for esbuild. It is harmless; the build works.

## Gotchas learned so far

- **LM Studio ignores unknown model ids** and silently uses the loaded model. `unlistedModelWarning()` warns at startup.
- **Multi-line pastes:** readline emits one line per newline. `PasteAwareLineReader` merges lines that arrive within 30 ms into one message (interactive only; piped input stays one line per message). Slash commands only count on single-line input.
- `heph --version` must stay fast. `cli/index.ts` lazy-imports `container.ts`.
- **Never write the `\uFEFF` escape in source**: the file-writing tool turns it into an invisible BOM character. Use `charCodeAt(0) === 0xfeff`.
- Markdown answers render block-by-block (`MarkdownBlockBuffer`), not per token: a block is released at a blank line or a closed code fence.
- `npm run dev` always runs from heph's own folder; use `-C <dir>` to point heph at another project.
- Every non-read tool passes `PermissionGate` in `ToolExecutor` (preview → gate → execute). Default gate = `denyAllChangesGate`. Write tools receive `WorkspaceWriter` via their constructor; it enforces read-before-edit, staleness, and protected paths (secrets, `.git/`, `.heph/`) even when the user approves.
- Messages to the model after a refused action start with `NOT APPLIED:`. Keep that wording: without it the model claimed changes it never made.
- Don't patch source with Node/sed scripts whose strings contain `\n`, `\[`, etc. (template literals interpret them). Use the Edit tool for code with escapes.
- To drive the real app in a simulated terminal: `startChat(options, new TerminalUI(fakeTtyIn, fakeTtyOut))` from `container.ts`.
- `run_command` goes through `Shell` (`shell/NodeShell.ts`): PowerShell via `-EncodedCommand` on Windows, `/bin/sh` elsewhere; CI=1, stdin closed, whole process tree killed on timeout/Ctrl+C. Dangerous commands (`DangerousCommandDetector`) ALWAYS ask, even in full-auto; allow rules never match commands containing `; && | > $(` etc.
- UI colours live in `ui/render/theme.ts`; backgrounds only when `chalk.level >= 2` and TTY. `TurnRenderer` tests use the plain theme. To check real rendering, pipe raw output into `@xterm/headless` with `convertEol: true` (install it in the scratchpad, not the project).
- Automated TTY input: send keys in separate writes. readline treats a multi-char chunk as a paste and disables Tab completion.
- Reads go through the gate too (`reads: ask` by default → first read asks, "a" allows all reads for the session). `PolicyPermissionGate`'s constructor defaults `reads` to 'auto' for test convenience; the product default 'ask' comes from config.
- TurnRenderer: always start the spinner via `#spin()` (it ends the current line first). The spinner's `\r\x1b[2K` erases whatever is on the current line.
- `container.ts` `createAgentSession()` builds everything for both chat and `heph run`. Add new tools/options there once.
- `heph run` exit codes: 0 ok, 1 error, 2 max steps, 130 Ctrl+C. Without a TTY all approvals are denied (`JsonOutput`/`TerminalUI.ask`).
- E2E tests (`tests/e2e/`) spawn `node node_modules/tsx/dist/cli.mjs src/cli/index.ts …` against a fake OpenAI server; set HOME/USERPROFILE to a temp dir so the user's real ~/.heph config isn't read.
- Context: `core/context/ContextManager.ts` fits every request (elide old tool outputs → drop whole oldest turns) and compacts (LLM summary) at most once per turn when ≥75% full and the old part is ≥15% of the budget. Never split a tool call from its result. `Agent.contextUsage()` reports the FITTED size.
- Context window: profile `contextWindow` > LM Studio `GET /api/v0/models` `loaded_context_length` > default (16k local / 128k cloud). Note the user's LM Studio context size changes when they reload the model.
- Sessions: `.heph/sessions/<id>.json` (git-ignored via `ensureGitignore`), autosaved by `ChatRepl.afterEach`; the system prompt is rebuilt on resume, not stored.
