# KOS

**An AI agent with its own workspace, its own toolkit, and its own schedule —
one that does things when you are not talking to it.**

Ask it for a reading tracker. It designs a schema, migrates the database,
writes the pages, and serves a working site on its own port. Then, because it
decided that job was worth keeping, it messages you at noon asking whether you
read anything, with buttons to log progress without typing. It runs entirely
on your own machine, inside one folder it is structurally incapable of
leaving.

<table>
<tr><td><b>Stack</b></td><td>TypeScript · Node 20 · React · SQLite (+ vector search) · Docker · Anthropic &amp; OpenAI · Discord API · iMessage</td></tr>
<tr><td><b>Scale</b></td><td>~41,000 lines of source · ~19,000 lines of tests · <b>1,272 tests</b> across 126 files</td></tr>
<tr><td><b>Process</b></td><td><b>239 pull requests</b>, every one merged, every one green through typecheck, lint, tests, UI build and container build</td></tr>
</table>

```
  triggers              the loop                  what it reaches
  ────────              ────────                  ───────────────

  you ───────┐                                 ┌── 84 tools, 16 families
  a schedule ┼──→  model → tools → repeat  ──→ ┼── coding sub-agents
  itself ────┘         until it stops          └── daemons it supervises
                            │
             every call: risk tier → approval if needed → audit
                            ▼
                one workspace directory it cannot leave
```

---

## How it acts

**It runs a real tool-call loop.** The model is called, its tool calls are
executed, results are fed back, and it repeats until it stops asking or hits
an iteration cap. Every surface — Discord, iMessage, the dashboard, a
scheduled job — drives that same loop.

**It has 84 tools across 16 families.** Files, SQL, schema migrations, HTTP,
semantic and literal search, memory, projects, pages, sites, daemons,
schedules, sub-agents, skills, and its own conversations. When the toolkit is
narrowed for a turn, it can call `tools.list` to discover what else exists —
because a capability that silently vanishes is one the agent will confidently
report as impossible.

**It prompts itself.** A scheduled job is not limited to replaying canned
calls. A `self_prompt` job hands the agent an instruction on a cron and lets
it work out what to do — which is how the noon nudge reads the database,
decides what actually matters today, and composes the message.

**It delegates.** An orchestrator conversation holds `chats.dispatch` and can
farm work out to other conversations, each with its own brief and tool
allow-list. Dispatched conversations never receive those tools themselves, so
delegation is **one level deep by construction** rather than by convention.

**It runs other agents.** For work too large to write a line at a time, it
hands a scoped task to a Claude Code sub-agent whose working directory is a
folder *inside* the workspace — so a build pointed at one site cannot read
another, let alone the database.

**It keeps programs alive.** Daemons it spawns are supervised and restarted
with backoff, because a process that crashes on startup will crash again
immediately and a naive supervisor turns that into a spin that eats the
machine.

**It decides what to remember.** A salience heuristic chooses what is worth
writing to long-term memory; recall is semantic, through `sqlite-vec`, with
literal search as the fast path.

**It improves itself.** It can write a new skill, have it sandbox-tested in a
child process against a throwaway database copy, and promoted — automatically
if the risk classifier says it is safe, into the approval queue if not.

---

## What autonomy requires

Getting a model to call a function is the easy half. The hard half is
everything that has to hold when the agent is acting on its own, the model is
wrong, and nobody is awake to approve anything. That is what most of this
codebase is.

| Problem | Approach |
| --- | --- |
| An agent writing files can escape its directory | One `resolvePath()` gate every path goes through; rejects `..`, NUL bytes, absolute escapes, **and all symlinks** |
| An agent can be talked into a destructive call | Risk is computed in the harness from a static floor plus deterministic argument escalation, **never judged by the model** |
| A risky call needs a human, but humans sleep | Interactive turns suspend mid-turn and resume on your decision; scheduled runs queue the action and finish, so one approval never blocks a shared lane |
| A self-modifying agent is a supply-chain risk | Agent-written skills are sandbox-tested against a throwaway database copy before promotion |
| Agents corrupt their own state | Every schema change goes through a guarded `migrate` primitive — versioned, git-snapshotted, restorable |
| "It said it did the thing" | Every tool call is audited with arguments, result, risk tier and caller |

### Risk is computed, never asked

A tool declares a static floor; its arguments escalate it deterministically —
deleting one file is not the same call as deleting a glob. The model is never
consulted about how dangerous its own request is, because the model is exactly
the component that might be wrong or manipulated.

### Confinement is structural, not a filter

The iMessage integration is the sharpest example. Apple's `chat.db` holds
every conversation you have ever had — on the machine this was built against,
154,000 messages across 379 contacts. The reader binds every query to a single
conversation **in the SQL itself**. There is no code path that constructs a
statement without that binding, so "what did someone else say" cannot be
expressed, let alone answered.

It is tested against a fixture that deliberately contains other people's
messages, because a fixture holding only the target thread would have passed
whatever the query said.

### Secrets the agent never sees

Keys live outside the workspace, are referenced by name, injected at call time
and redacted from logs. Agent-written skills get an allow-listed environment —
an early bug where child processes inherited `process.env`, and so could read
every API key, is why that list exists.

---

## Architecture

A pnpm monorepo, TypeScript end to end:

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
  running work. A lane-based work queue keeps same-lane calls ordered and
  different lanes concurrent.
- **SQLite only.** One workspace file, JSON columns for document cases,
  `sqlite-vec` for embeddings. One file to back up, one file to move.
- **Presentation-first UI.** The agent emits page specs as JSON and a fixed
  widget library renders them — no build step when the agent adds a page, and
  no arbitrary React from a model. `custom_html` renders inside a sandboxed
  iframe.
- **The container is the real jail.** `resolvePath()` is the in-process
  perimeter on top of it. A bug should be a bug, not a breach.

---

## Testing

Tests here are written against **failure modes, not coverage**. Each documents
the bug it exists to prevent, and the load-bearing ones were verified by
reintroducing the bug and watching them fail — a test that has never failed
has never been shown to work.

A representative sample, all real regressions this project shipped and fixed:

- the path jail refusing a symlinked component
- the iMessage reader unable to reach another conversation
- a scheduled run queueing an approval instead of blocking on it
- the orchestrator refused a tool it named but was not granted
- a surface that cannot deliver a message not taking the whole host down

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

Then open `http://127.0.0.1:4317`, or attach a REPL with `pnpm kos`.

### Configuration

All via `.env` (git-ignored; `.env.example` documents every key):

```bash
ANTHROPIC_API_KEY=      # preferred when both are set
OPENAI_API_KEY=         # works alone; the router falls back

KOS_SECRET_DISCORD=     # Discord bot token
KOS_OWNER_DISCORD=      # your user id — also the inbound gate

KOS_OWNER_IMESSAGE=     # your own handle; enables the iMessage surface
KOS_WORKSPACE=          # defaults to ~/kos-workspace
```

The iMessage surface is macOS-only and needs Full Disk Access plus Automation
permission for Messages. It reads exactly one thread — your own — and stays
off entirely unless you name it.

### Running contained

```bash
docker compose up
```

The container is the strong jail and is mandatory for unattended cron. The
iMessage surface is the one exception: it needs the host's Messages.app and
cannot run inside it.

---

## Status

Actively built. The agent loop, store, channels, tools, memory, projects,
cron, operational spine and UI are all in place, along with the conversation
and orchestration layers above them.

Known gaps, stated plainly: SMS is not implemented (Discord and iMessage are);
the module promotion path is specified but only one module exercises
instancing; PDF export is not built; and execution across conversations is
deliberately serial rather than parallel.

---

## License

Not yet licensed. Until a license file is added, default copyright applies and
no reuse rights are granted.
