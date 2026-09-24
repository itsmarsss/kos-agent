# KOS

**A self-hosted AI agent that owns a directory, builds real software inside
it, and answers you on your phone.**

Ask it for a reading tracker. It designs a schema, migrates the database,
writes the pages, and serves a working site on its own port — then messages
you at noon asking whether you read anything, with buttons to log progress
without typing. It runs entirely on your own machine, inside one folder it is
structurally incapable of leaving.

<table>
<tr><td><b>Stack</b></td><td>TypeScript · Node 20 · React · SQLite (+ vector search) · Docker · Anthropic &amp; OpenAI · Discord API · iMessage</td></tr>
<tr><td><b>Scale</b></td><td>~41,000 lines of source · ~19,000 lines of tests · <b>1,272 tests</b> across 126 files</td></tr>
<tr><td><b>Process</b></td><td><b>239 pull requests</b>, every one merged, every one green through typecheck, lint, tests, UI build and container build</td></tr>
</table>

```
you ──→ Discord / iMessage / dashboard / CLI
             │
             ▼
        ┌─────────────────────────────────────────┐
        │  kernel: conversations, work queue,     │
        │  risk classifier, approval queue        │
        └─────────────────────────────────────────┘
             │              │              │
        guarded tools   model router   scheduler
             │              │              │
             ▼              ▼              ▼
        ┌─────────────────────────────────────────┐
        │  the jail: one workspace directory      │
        │  SQLite · files · projects · sites      │
        └─────────────────────────────────────────┘
```

---

## What it does

- **Builds and ships software.** Creates projects, evolves their schemas
  through a guarded migration primitive, writes pages, and serves each site on
  its own origin.
- **Runs coding sub-agents.** Hands a scoped task to a Claude Code sub-agent
  inside the workspace and streams its progress back into the conversation.
- **Remembers.** Hybrid memory — SQLite facts chosen by a salience heuristic,
  plus semantic episodic recall through `sqlite-vec`.
- **Works while you sleep.** Scheduled jobs live in SQLite rather than
  crontab, so they are portable and inspectable, and each keeps its own
  conversation thread you can read back.
- **Reaches you anywhere.** Discord with embeds, buttons, modals and slash
  commands; iMessage; a React dashboard; a terminal REPL. One kernel behind
  all of them.
- **Improves itself.** Writes a skill, sandbox-tests it, and promotes it
  behind a risk classifier.

---

## The hard part

Getting a model to call a function is the easy half. The hard half is what
has to hold when the model is wrong, the network fails, or a job fires at 3am
with nobody awake to approve anything. That is what most of this codebase is.

| Problem | Approach |
| --- | --- |
| An agent writing files can escape its directory | One `resolvePath()` gate every path goes through; rejects `..`, NUL bytes, absolute escapes, **and all symlinks** |
| An agent can be talked into a destructive call | Risk is computed in the harness from a static floor plus deterministic argument escalation, **never judged by the model** |
| A risky call needs a human, but humans sleep | Interactive turns suspend mid-turn and resume on your decision; scheduled runs queue the action and finish, so one approval never blocks a shared lane |
| Agents corrupt their own state | Every schema change goes through a guarded `migrate` primitive — versioned, git-snapshotted, restorable |
| Self-modifying agents are a supply-chain risk | Agent-written skills run in a sandboxed child process against a throwaway database copy; safe ones auto-commit, risky ones queue for approval |
| "It said it did the thing" | Every tool call is audited with arguments, result, risk tier and caller |

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

### Risk is computed, never asked

A tool declares a static floor; its arguments escalate it deterministically —
deleting one file is not the same call as deleting a glob. The model is never
consulted about how dangerous its own request is, because the model is exactly
the component that might be wrong or manipulated.

### Secrets the model never sees

Keys live outside the workspace, are referenced by name, injected at call time
and redacted from logs. Agent-written skills get an allow-listed environment —
an early bug where child processes inherited `process.env`, and so could read
every API key, is why that list exists.

---

## Architecture

A pnpm monorepo, TypeScript end to end:

| Package | Role |
| --- | --- |
| `packages/harness` | The kernel: jail, store, agent loop, tools, cron, memory, channels, ops |
| `packages/ui` | Fixed React shell that renders agent-authored page specs |
| `packages/cli` | The `kos` command: REPL, host, ops, doctor |
| `packages/shared` | Contracts both sides import |

Decisions that shaped everything downstream:

- **SQLite only.** One workspace file, JSON columns for document cases,
  `sqlite-vec` for embeddings. One file to back up, one file to move.
- **Execution is serial.** Conversations are parallel as *threads*, not as
  running work. A lane-based work queue keeps same-lane calls ordered and
  different lanes concurrent.
- **Presentation-first UI.** The agent emits page specs as JSON and a fixed
  widget library renders them — no build step when the agent adds a page, and
  no arbitrary React from a model. `custom_html` renders inside a sandboxed
  iframe.
- **Display is read-only.** Writes go through a guarded mutation path in each
  widget's own idiom.
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
- the session store measuring its history once per turn rather than twice
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

Actively built. The store, agent loop, channels, tools, memory, projects,
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
