# heph — Product Requirements Document (PRD)

| | |
|---|---|
| **Status** | Draft v0.1 |
| **Date** | 2026-11-08 |
| **Project type** | Learning project, released as open source |
| **CLI command** | `heph` (npm package `heph-cli`, free as of 2026-11-08) |

---

## 1. Problem statement

Developers want an AI pair-programmer in the terminal that can read their project, suggest changes, edit files and run commands. Existing tools are hard to learn from because they are big, closed-source, or tied to one model provider.

**heph** is a small, readable, well-structured CLI coding agent that:
1. works with **any OpenAI-compatible API**: OpenAI in the cloud, or **LM Studio** (or Ollama, vLLM) running on your own machine;
2. **never changes a file or runs a command without asking the user**, unless the user has explicitly turned on a more automatic mode;
3. is built to be **learned from**, so every part is small, sits behind an interface, and has tests.

## 2. Goals and non-goals

### Goals
| # | Goal | How we measure it |
|---|------|-------------------|
| G1 | Learn how coding agents work from the inside (the agent loop, tool calling, context, permissions) | Each roadmap milestone ships with tests and a short write-up in `docs/learning-notes/` |
| G2 | Run fully offline with a local LLM through LM Studio | `heph --profile local` completes the demo task with no internet |
| G3 | Safe by default | No write or exec tool runs without approval in the default mode. This is enforced by tests |
| G4 | Clean, extensible design (SOLID) | A new tool or LLM provider can be added **without editing existing core classes** |
| G5 | Installable by anyone | `npm install -g heph-cli` works on Windows, macOS and Linux |

### Non-goals (v1)
- An IDE plugin or GUI. Terminal only.
- Multi-agent orchestration or sub-agents. This is a stretch goal.
- Running code inside a container or VM sandbox. v1 relies on permission prompts and path guards, and this limitation is written down in SECURITY.md.
- Training or fine-tuning models.

## 3. Target users / personas

| Persona | Need |
|---------|------|
| **The learner (you)** | Wants to understand and extend every line of the agent. |
| **The privacy-conscious dev** | Wants an agent that runs only on a local model, so no code leaves the machine. |
| **The OSS contributor** | Wants a clean codebase where adding a tool or provider is a small, isolated PR. |

## 4. User stories

| ID | As a… | I want to… | So that… | Priority |
|----|-------|-----------|----------|----------|
| US-1 | developer | start an interactive chat in my project with `heph` | I can ask questions about my code | P0 |
| US-2 | developer | let the agent read files, list folders and search the code | it answers using my real code, not guesses | P0 |
| US-3 | developer | **see a diff and approve or reject it** before any file is changed | I stay in control of my code | P0 |
| US-4 | developer | **approve or reject** every shell command before it runs | nothing dangerous runs behind my back | P0 |
| US-5 | developer | switch between OpenAI and LM Studio with a flag or config profile | I can test cheaply offline and use stronger models when needed | P0 |
| US-6 | developer | run a one-shot task: `heph run "add a test for utils.ts"` | I can script it | P1 |
| US-7 | developer | answer "always allow" for a tool for the rest of a session | I'm not asked 50 times for the same safe action | P1 |
| US-8 | developer | undo the agent's last change (`/undo`) | mistakes are cheap | P1 |
| US-9 | developer | put project rules in a `HEPH.md` file | the agent follows my conventions | P2 |
| US-10 | developer | see token usage and cost per session | I control my spending | P2 |
| US-11 | developer | resume a previous session | long tasks survive restarts | P2 |

## 5. Functional requirements

### 5.1 CLI surface
```
heph                         # interactive chat (REPL) in the current folder
heph run "<task>"            # one-shot, non-interactive task
heph init                    # create .heph/config.json + HEPH.md
heph config list|get|set     # manage configuration
heph --profile <name>        # choose an LLM profile (e.g. openai, local)
heph --mode <mode>           # read-only | ask (default) | auto-edit | full-auto
heph --version / --help
```

Slash commands inside the REPL: `/help`, `/mode <mode>`, `/model <name>`, `/undo`, `/clear`, `/tokens`, `/exit`.

### 5.2 Tools (v1)
| Tool | Risk level | Description |
|------|-----------|-------------|
| `list_directory` | read | List files and folders (respects `.gitignore`) |
| `read_file` | read | Read a file, optionally a line range |
| `glob` | read | Find files by pattern, e.g. `src/**/*.ts` |
| `grep` | read | Search file contents with a regex |
| `write_file` | write | Create a new file or overwrite one (diff shown first) |
| `edit_file` | write | Replace an exact, unique text snippet in a file (diff shown first) |
| `run_command` | execute | Run a shell command with a timeout (command shown first) |

### 5.3 Permissions (summary; full design in the Technical Design doc §6)
- **FR-P1** Every tool declares a risk level: `read`, `write` or `execute`.
- **FR-P2** Default mode `ask`: reads inside the workspace are automatic; writes and executes **always prompt**.
- **FR-P3** The prompt shows exactly what will happen (a coloured diff, or the full command) and offers: `[y] yes · [n] no · [a] always this session · [f] no, and give feedback`.
- **FR-P4** No tool may touch a path **outside the workspace root**, in any mode. This includes `..`, absolute paths and symlinks that escape the root.
- **FR-P5** Sensitive files (`.env*`, `*.pem`, `id_rsa*`, `.git/`) are blocked or need an extra confirmation, even for reads.
- **FR-P6** Rejections go back to the LLM as a tool result ("User denied: …") so the agent can adapt.

### 5.4 LLM providers
- **FR-L1** One `OpenAICompatibleProvider` serves OpenAI, LM Studio, Ollama and vLLM; only `baseURL`, `apiKey` and `model` differ.
- **FR-L2** Responses stream token by token.
- **FR-L3** Native tool/function calling is used.
- **FR-L4** Provider errors (timeouts, 429s, a model without tool support) are reported with a clear explanation.

## 6. Non-functional requirements
| Area | Requirement |
|------|-------------|
| Safety | Safe defaults. Destructive actions need explicit consent, and an audit log is written to `.heph/logs/`. |
| Portability | Windows (PowerShell), macOS and Linux. Node.js ≥ 20 LTS. |
| Performance | Startup in under 500 ms. Tool output is truncated so it does not blow up the context window. |
| Privacy | No telemetry. API keys come only from env vars or the user-level config, never from the project. |
| Code quality | TypeScript strict mode, ESLint and Prettier, at least 80% unit-test coverage for `core/`, `tools/` and `permissions/`. |
| Docs | README, CONTRIBUTING, SECURITY, CHANGELOG, and learning notes for each milestone. |

## 7. Success criteria for v1.0
1. With **LM Studio + a tool-capable 7B model**, `heph` can: explain a file, find where a function is used, add a function with the user approving the diff, and run the project's tests with the user approving the command.
2. The same flow works with OpenAI by changing only `--profile`.
3. Every write/exec path has a test proving it **cannot run without approval** in `ask` mode.
4. The package is published to npm with a tagged GitHub release built by CI.

## 8. Risks
| Risk | Mitigation |
|------|-----------|
| Small local models are bad at tool calling | Validate tool arguments with zod, send validation errors back to the model, recommend tested models in the README |
| Agent loops forever | Cap iterations per turn (default 25) and let the user interrupt with Ctrl+C |
| User approves a dangerous command | Show the full command clearly, warn on known-dangerous patterns (`rm -rf`, `git push --force`, `curl \| sh`), and document that v1 has no OS sandbox |
| Context window overflow | Token budgeting, output truncation and summarising old turns (M6) |

## 9. Release plan
`v0.x`: the learning milestones (see `03-LEARNING-ROADMAP.md`). `v1.0` ships when the success criteria are met. Licence: **MIT**. Versions follow semver, and the changelog is managed with Changesets.
