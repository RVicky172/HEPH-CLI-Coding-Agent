<p align="center">
  <img src="docs/assets/heph-logo.svg" alt="heph" width="420">
</p>

<p align="center"><em>A small, safe and readable coding agent for your terminal.</em></p>

heph reads your project, proposes changes as diffs, and runs commands, **always asking for your permission first**. It works with **OpenAI** or a **local model through LM Studio**, so your code never has to leave your machine.

> 🚧 Status: in planning. This is a learning project built in public.

| | |
|---|---|
| **npm package** | `heph-cli` |
| **Command** | `heph` |

## Planned documents
| Doc | What's inside |
|-----|---------------|
| [docs/01-PRD.md](docs/01-PRD.md) | Product requirements: goals, user stories, tools, permission requirements, success criteria |
| [docs/02-TECHNICAL-DESIGN.md](docs/02-TECHNICAL-DESIGN.md) | Tech stack, architecture, SOLID folder layout, tool logic, file-access and permission model, running locally, testing |
| [docs/03-LEARNING-ROADMAP.md](docs/03-LEARNING-ROADMAP.md) | Step-by-step milestones (M0–M7) with exercises and stretch goals |

## Quickstart (target experience)
```bash
npm install -g heph-cli
# Start LM Studio's local server (port 1234) with a tool-capable model, then:
heph --profile local
```

## Develop
```bash
npm install
npm run dev              # chat from source (LM Studio on localhost:1234, model "auto")
npm run dev -- models    # list models on the selected profile
npm run check            # typecheck + lint + format + unit tests
npm run test:llm         # live tests against LM Studio (skipped if it isn't running)
npm run build            # → dist/cli.js
npm link                 # use `heph` anywhere (undo: npm unlink -g heph-cli)
```

## Usage
```bash
heph                          # chat using the default profile ("local" = LM Studio)
heph -m qwen/qwen3-30b-a3b-2507
heph -p openai                # needs OPENAI_API_KEY
heph --base-url http://localhost:11434/v1 -m llama3.1   # any OpenAI-compatible server
heph models
heph -C D:\path\to\project    # work on another folder
heph --mode auto-edit         # read-only | ask (default) | auto-edit | full-auto
heph run "fix the failing test"               # one task, then exit (exit codes for scripts)
cat error.log | heph run "explain this error" # piped input becomes context; add --json for JSON lines
heph init                     # create HEPH.md (project rules for heph) + .heph/config.json
heph config                   # show effective settings (secrets masked)
heph -c                       # continue the last chat in this folder (sessions are saved automatically)
heph sessions                 # list saved sessions; resume one with --resume <id>
```
Every tool call and permission decision is recorded in `.heph/logs/audit-YYYY-MM-DD.jsonl`.
Long chats stay inside the model's context window automatically: old tool outputs are shortened and older turns summarised (`ctx %` shows how full it is). The window is detected from LM Studio, or set `"contextWindow"` in a profile.
In chat: `/help`, `/mode [mode]`, `/undo`, `/context`, `/compact`, `/model [id]`, `/clear`, `/exit`. **Ctrl+C** interrupts an answer.

## Safety model
- **Reads** (`list_directory`, `read_file`, `glob`, `grep`) ask first: answer **a** once to allow reading for the whole session (`--reads auto` to skip). Only files inside the workspace folder can ever be read.
- **Changes** (`edit_file`, `write_file`) show a coloured diff first, then ask: **y** yes · **a** always for this tool · **n** no · **f** no, with feedback.
- **Commands** (`run_command`: PowerShell on Windows, `sh` elsewhere) show the exact command first and ask every time (even in `auto-edit`). "Always" covers only that exact command. Dangerous commands (`rm -rf`, `git push --force`, `curl … | sh`, …) are flagged in red and **always** ask, even in `full-auto`.
- Rules in `~/.heph/config.json`: `"permissions": { "allow": ["run_command:npm test"], "deny": ["run_command:git push*"] }`.
- `/undo` reverts the last change. heph must read a file before editing it, and refuses if you changed it in the meantime.
- Never touched, in any mode: anything outside the workspace, secrets (`.env`, `*.pem`, `id_rsa`…), `.git/`, `.heph/`.
- A project's own `.heph/config.json` can make heph stricter, but can never loosen permissions or redirect your API key.

## License
MIT
