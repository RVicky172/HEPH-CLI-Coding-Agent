# heph — Learning Roadmap

Build the agent in **small milestones**. Each one teaches a concept, ends with working software, and leaves a note in `docs/learning-notes/MXX.md` (what you learned, what surprised you, what you would change).

Rule of thumb for every milestone: **interface first → fake implementation + tests → real implementation → try it on LM Studio.**

---

### M0: Forge setup (½ day)
**Learn:** TypeScript project setup, ESM, CLI binaries.
- `npm init`, TypeScript strict, tsup, Vitest, ESLint/Prettier, the folder skeleton from the design doc §3.
- `heph --version` and `heph --help` work through `commander`.
- A GitHub repo with CI running lint and tests on Windows, macOS and Linux.

**Done when:** `npm run build && node dist/cli.js --version` prints the version, and CI is green.

### M1: Talk to the oracle (1 day)
**Learn:** Chat Completions API, streaming, the provider abstraction (DIP).
- Define `LLMProvider` and `Message`, then implement `OpenAICompatibleProvider`.
- `ConfigLoader` with `local` and `openai` profiles.
- A simple REPL: type a message and stream the reply. Keep the conversation history.

**Exercise:** run the same prompt on LM Studio and on OpenAI and compare.
**Done when:** `heph --profile local` chats with LM Studio, and switching profiles needs no code change.

### M2: Give it eyes, using read-only tools and the agent loop (2 days) ⭐ the key milestone
**Learn:** function calling, JSON Schema, the agent loop, feeding errors back to the model.
- The `Tool` interface, `ToolRegistry`, and `ToolExecutor` (no permissions yet, because read tools only).
- `list_directory`, `read_file`, `glob`, `grep`, plus `PathGuard` (with its tests!).
- `Agent.runTurn` loop and `ScriptedProvider` for deterministic tests.

**Exercise:** ask "Where is the function X used?" in a real repo and watch the tool calls.
**Done when:** the agent answers questions about a codebase by reading it, and loop tests pass without an LLM.

### M3: Give it hands, with permission (2 days) 🛡️
**Learn:** risk modelling, Strategy pattern, interface segregation, UX for consent.
- `PermissionGate`, `PermissionMode`, `SessionGrants`, and an `Approver` implemented by `TerminalUI`.
- `write_file`, then `edit_file` (unique exact match), with diff previews.
- `CheckpointStore` and `/undo`.
- Write **all** the must-have safety tests from design doc §9.

**Done when:** the agent can add a function to a file, the user sees a coloured diff and approves it, and "no" plus feedback makes the agent adapt.

### M4: Light the furnace with the shell tool (1 day)
**Learn:** child processes, timeouts, cancellation (`AbortController`), cross-platform shells.
- `run_command` via `execa`, plus `DangerousCommandDetector`.
- Allow and deny rules in config (`run_command:npm test`).
- Ctrl+C cancels the running command and the current turn cleanly.

**Exercise:** "Run the tests and fix whatever fails." This is your first real agentic task.
**Done when:** the agent runs tests, reads failures, edits code and re-runs, asking at each step.

### M5: Craftsmanship in the CLI (1–2 days)
**Learn:** UX polish, slash commands (Open/Closed).
- Markdown rendering, spinners, a token and cost display (`/tokens`).
- `heph run "<task>"` non-interactive mode (deny on prompt when there is no TTY).
- `heph init`, `HEPH.md` loading, and `SystemPromptBuilder`.
- An audit log.

### M6: Memory of the forge, through context management (2 days)
**Learn:** tokens, context windows, summarisation and its trade-offs.
- `ContextManager` with a truncation strategy, then a compaction (summarise) strategy.
- Session save and resume (`.heph/sessions/*.json`).

**Exercise:** run a long task on a 16k-context local model and see where it breaks, then fix it.

### M7: Release to the world, v1.0 (1 day)
**Learn:** OSS packaging and release engineering.
- README with a demo GIF, CONTRIBUTING ("add a tool in 5 steps"), SECURITY, a licence.
- Changesets, a release workflow, `npm publish --provenance`.
- Test a global install on a clean machine or VM (Windows plus one Unix).

---

### Stretch goals (pick by curiosity)
| Idea | What you learn |
|------|----------------|
| **MCP client**: use any MCP server's tools | Adapter pattern, the JSON-RPC protocol |
| **Plan mode**: the agent proposes a plan in `read-only` mode before editing | Prompt design, workflow state |
| **Sub-agents**: a "researcher" agent with read-only tools | Composition, context isolation |
| **Docker sandbox** for `run_command` | Real isolation versus permission prompts |
| **Ink UI** (React in the terminal) | Swapping a UI implementation without touching the core (proof of DIP) |
| **Eval harness**: a set of tasks in fixture repos, scoring the pass rate per model | How agent quality is actually measured |
| **Native Anthropic / Gemini providers** | Mapping different tool-calling formats onto one interface |

---

### Reading list while you build
- OpenAI docs: *Function calling* and *Streaming*.
- LM Studio docs: *OpenAI compatibility API* and *Tool use*.
- "Building effective agents" (Anthropic engineering blog), on simple loops versus frameworks.
- *Clean Architecture* (Robert C. Martin), chapters on SOLID and the Dependency Rule.
- Source code of open-source agents (e.g. Aider, OpenAI Codex CLI, opencode), to compare their tool designs with yours.
