# KOS

**An AI agent with its own workspace, its own toolkit, and its own schedule.
It does things when you are not talking to it.**

Ask it for a reading tracker and it will:

1. design a schema and migrate the database
2. write the pages and serve the site on its own port
3. decide the job is worth keeping, and schedule itself a daily check
4. message you at noon with buttons to log progress without typing

It runs entirely on your machine, inside one folder it is structurally
incapable of leaving.

### By the numbers

| | |
| --- | --- |
| **84 tools** in 16 families | files, SQL, schema migrations, HTTP, search, memory, projects, sites, daemons, schedules, sub-agents, skills |
| **1,272 tests** across 126 files | ~19,000 lines of tests against ~41,000 lines of source |
| **239 pull requests** | every one merged, every one green |
| **4 surfaces** | Discord, iMessage, web dashboard, terminal REPL |
| **21 tables, 70 API routes** | one SQLite file, one local server |

**Stack:** TypeScript, Node 20, React, SQLite with vector search, Docker,
Anthropic and OpenAI, Discord API, AppleScript.

---

## How a turn works

```
 STARTED BY      you  ·  a schedule  ·  the agent itself
                                │
                                ▼
 ┌────────────────────────────────────────────────────────────┐
 │  AGENT LOOP    model  →  tool calls  →  results  →  repeat │
 └────────────────────────────────────────────────────────────┘
                                │
                                ▼
 ┌────────────────────────────────────────────────────────────┐
 │  EVERY CALL    risk tier  →  approval if risky  →  audited │
 └────────────────────────────────────────────────────────────┘
                                │
                                ▼
 ┌────────────────────────────────────────────────────────────┐
 │  WORKSPACE     84 tools · SQLite · files · sites · daemons │
 │                one directory, and no path may leave it     │
 └────────────────────────────────────────────────────────────┘
```

Three things can start that loop, and only one of them is you.

---

## What makes it an agent

**It prompts itself.**
A scheduled job is not a list of canned calls. It hands the agent an
instruction and lets it work out what to do. That is how the noon nudge reads
the database, decides what actually matters today, and writes the message.

**It delegates.**
An orchestrator conversation farms work out to other conversations, each with
its own brief and tool allow-list. Dispatched conversations never receive the
dispatch tools, so delegation stays one level deep by construction.

**It runs other agents.**
For work too large to write a line at a time, it hands a scoped task to a
Claude Code sub-agent. That sub-agent's working directory is a folder *inside*
the workspace, so a build pointed at one site cannot read another.

**It discovers its own capabilities.**
When the toolkit is narrowed for a turn, the agent can call `tools.list` to
find what else exists. A capability that silently vanishes is one the agent
will confidently report as impossible.

**It keeps programs alive.**
Daemons it spawns are supervised and restarted with backoff. A process that
crashes on startup will crash again immediately, and a naive supervisor turns
that into a spin that eats the machine.

**It chooses what to remember.**
A salience heuristic decides what reaches long-term memory. Recall is
semantic, through `sqlite-vec`, with literal search as the fast path.

**It improves itself.**
It can write a new skill, have it sandbox-tested in a child process against a
throwaway database copy, then promoted. Safe ones commit automatically, risky
ones go to the approval queue.

---

## What autonomy requires

Getting a model to call a function is the easy half.

The hard half is what holds when the agent acts alone, the model is wrong, and
nobody is awake to approve anything. That is most of this codebase.

| Problem | Approach |
| --- | --- |
| An agent writing files can escape its directory | One `resolvePath()` gate every path goes through. Rejects `..`, NUL bytes, absolute escapes, **and all symlinks** |
| An agent can be talked into a destructive call | Risk is computed in the harness from a static floor plus deterministic argument escalation, **never judged by the model** |
| A risky call needs a human, but humans sleep | Interactive turns suspend and resume on your decision. Scheduled runs queue the action and finish, so one approval never blocks a lane |
| A self-modifying agent is a supply-chain risk | Agent-written skills are sandbox-tested against a throwaway database copy before promotion |
| Agents corrupt their own state | Every schema change goes through a guarded `migrate` primitive: versioned, git-snapshotted, restorable |
| "It said it did the thing" | Every tool call is audited with arguments, result, risk tier and caller |

### Risk is computed, never asked

A tool declares a static floor. Its arguments escalate it deterministically,
so deleting one file is not the same call as deleting a glob.

The model is never consulted about how dangerous its own request is, because
the model is exactly the component that might be wrong or manipulated.

### Confinement is structural, not a filter

Apple's `chat.db` holds every conversation you have ever had. On the machine
this was built against, that is 154,000 messages across 379 contacts.

The iMessage reader binds every query to a single conversation *in the SQL
itself*. No code path constructs a statement without that binding, so "what
did someone else say" cannot be expressed, let alone answered.

It is tested against a fixture that deliberately contains other people's
messages. A fixture holding only the target thread would have passed whatever
the query said.

### Secrets the agent never sees

Keys live outside the workspace, are referenced by name, injected at call time
and redacted from logs.

Agent-written skills get an allow-listed environment. An early bug where child
processes inherited `process.env`, and so could read every API key, is why
that list exists.

---

## Architecture

| Package | Role |
| --- | --- |
| `packages/harness` | The kernel: agent loop, jail, store, tools, cron, memory, channels, ops |
| `packages/ui` | Fixed React shell that renders agent-authored page specs |
| `packages/cli` | The `kos` command: REPL, host, ops, doctor |
| `packages/shared` | Contracts both sides import |

Decisions that shaped everything downstream:

- **Conversations are the unit of work.** Each carries a brief and a tool
  allow-list. Permissions are an owner decision, never one the agent makes for
  a conversation it created.
- **Execution is serial.** Conversations are parallel as *threads*, not as
  running work. A lane-based queue keeps same-lane calls ordered and different
  lanes concurrent.
- **SQLite only.** One workspace file, JSON columns for document cases,
  `sqlite-vec` for embeddings. One file to back up, one file to move.
- **The agent writes JSON, not React.** It emits page specs; a fixed library
  of 8 widget kinds renders them. No build step when it adds a page, and no
  arbitrary markup from a model. `custom_html` renders in a sandboxed iframe.
- **The container is the real jail.** `resolvePath()` is the in-process
  perimeter on top of it. A bug should be a bug, not a breach.

---

## Testing

Tests here are written against failure modes, not coverage.

Each documents the bug it exists to prevent. The load-bearing ones were
verified by reintroducing the bug and watching them fail, because a test that
has never failed has never been shown to work.

Real regressions this project shipped and fixed:

- the path jail refusing a symlinked component
- the iMessage reader unable to reach another conversation
- a scheduled run queueing an approval instead of blocking on it
- the orchestrator refused a tool it named but was not granted
- a surface that cannot deliver a message not taking the whole host down

CI runs typecheck, lint, the full suite, a UI build and the container build on
every pull request.

---

## Quick start

Requires Node >= 20 and pnpm.

```bash
pnpm install
pnpm build:all          # TypeScript + UI assets
cp .env.example .env    # set at least one model key
pnpm doctor             # preflight
pnpm start              # host: API + dashboard + cron + channels
```

Open `http://127.0.0.1:4317`, or attach a REPL with `pnpm kos`.

### Configuration

All via `.env`, which is git-ignored. `.env.example` documents every key.

```bash
ANTHROPIC_API_KEY=      # preferred when both are set
OPENAI_API_KEY=         # works alone; the router falls back

KOS_SECRET_DISCORD=     # Discord bot token
KOS_OWNER_DISCORD=      # your user id, and the inbound gate

KOS_OWNER_IMESSAGE=     # your own handle; enables the iMessage surface
KOS_WORKSPACE=          # defaults to ~/kos-workspace
```

The iMessage surface is macOS only. It needs Full Disk Access plus Automation
permission for Messages, reads exactly one thread (your own), and stays off
unless you name it.

### Running contained

```bash
docker compose up
```

The container is the strong jail and is mandatory for unattended cron.
iMessage is the one exception: it needs the host's Messages.app.

---

## Status

Actively built. The agent loop, store, channels, tools, memory, projects,
cron, operational spine and UI are all in place, along with the conversation
and orchestration layers above them.

Known gaps, stated plainly:

- SMS is not implemented; Discord and iMessage are
- the module promotion path is specified, but only one module exercises
  instancing
- PDF export is not built
- execution across conversations is deliberately serial, not parallel

---

## License

Not yet licensed. Until a license file is added, default copyright applies and
no reuse rights are granted.
