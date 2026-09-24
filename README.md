# KOS

**A self-hosted AI agent that owns a directory and is reachable from your phone.**

KOS is a personal operating system for an LLM. It lives in one workspace
folder, builds and runs real software inside it, remembers what you tell it,
acts on a schedule while you are asleep, and answers on Discord, iMessage, or
a web dashboard. Everything it does is logged, reversible, and confined.

The interesting part is not that an LLM can call tools. It is what has to be
true for that to be safe when nobody is watching.

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

## Why it exists

Most agent frameworks answer "how do I get a model to call a function". That
is the easy half. The hard half is everything that has to hold when the model
is wrong, the network fails, or a scheduled job fires at 3am with nobody
awake to approve anything.

KOS is built around that second half:

| Problem | What KOS does |
| --- | --- |
| An agent writing files can escape its directory | One `resolvePath()` gate every path goes through; rejects `..`, NUL bytes, absolute escapes, **and all symlinks** |
| An agent can be talked into a destructive call | Risk is computed in the harness from a static floor plus argument escalation, **never judged by the model** |
| A risky call needs a human, but humans sleep | Interactive turns suspend and wait; scheduled runs queue the action and finish, so one approval never blocks a lane |
| Agents corrupt their own state | Every DDL change goes through a guarded `migrate` primitive, versioned, git-snapshotted, restorable |
| Self-modifying agents are a supply-chain risk | Agent-written skills run in a sandboxed child process against a throwaway DB copy; safe ones auto-commit, risky ones queue for approval |
| "It said it did the thing" | Every tool call is audited with args, result, risk tier, and caller |

---

## What it can do

- **Build real software.** Ask for a budget tracker and it creates a project,
  migrates a schema, writes pages, and serves a working site on its own port
  and origin.
- **Run sub-agents.** `builds.run` hands a scoped coding task to a Claude Code
  sub-agent inside the workspace, streaming its progress back to the chat.
- **Remember.** Hybrid memory: SQLite facts with a salience heuristic, plus
  vector episodic recall through `sqlite-vec`.
- **Work unattended.** Cron jobs in SQLite, not crontab — portable,
  inspectable, and each with its own conversation thread you can read back.
- **Reach you anywhere.** Discord (embeds, buttons, modals, slash commands),
  iMessage, a React dashboard, and a terminal REPL — all the same kernel.
- **Improve itself.** Write a skill, sandbox-test it, promote it behind the
  risk classifier.

---

## The security model

This is the part worth reading the code for.

### One gate, no exceptions

Every filesystem, SQL, and shell path resolves through `resolvePath()`. It
returns a path provably inside the workspace root or throws. Symlinks are
refused outright rather than followed and checked — a symlink is a *potential*
escape, and the gate does not trust targets it would have to re-validate.

### Risk is computed, never asked

A tool declares a static floor (`safe` / `risky`). Arguments escalate it
deterministically — `files.rm` on a glob is not the same call as on one file.
The model is never consulted about how dangerous its own request is, because
the model is exactly the component that might be wrong or manipulated.

### Approvals that survive being unattended

An interactive turn **suspends** inside the turn and resumes on your decision,
keeping one conversation and one live view. A scheduled run does not: it
queues the action, says so in its thread, and finishes — because a cron job
blocking a shared queue slot for 30 minutes waiting for a human who is asleep
is how an agent takes itself down.

### Confinement extends to what it can read

The iMessage adapter is the sharpest example. `chat.db` holds every
conversation you have ever had. The reader binds every query to a single
conversation **in the SQL itself** — there is no code path that builds a
statement without it, so "what did someone else say" cannot be expressed, let
alone answered. It is tested against a fixture that deliberately contains
other people's messages, because a fixture holding only the target thread
would pass whatever the query said.

### Secrets the model never sees

Keys live outside the workspace, are referenced by name, injected at call
time, and redacted from logs. Agent-written skills get an allow-listed
environment — an early bug where child processes inherited `process.env` (and
so could read every API key) is why that list exists.

---

## Architecture

pnpm monorepo, TypeScript end to end:

| Package | Role |
| --- | --- |
| `packages/harness` | The kernel: jail, store, agent loop, tools, cron, memory, channels, ops |
| `packages/ui` | Fixed React shell that renders agent-authored page specs |
| `packages/cli` | The `kos` command: REPL, host, ops, doctor |
| `packages/shared` | Contracts both sides import |

**Design decisions that shaped everything else:**

- **SQLite only.** One workspace file, JSON columns for document cases,
  `sqlite-vec` for embeddings. One file to back up, one file to move.
- **Execution is serial.** Conversations are parallel as *threads*, not as
  running work. A work queue with lanes keeps same-lane calls ordered and
  different lanes concurrent.
- **Presentation-first UI.** The agent writes page specs (JSON); a fixed
  widget library renders them. No build step when the agent adds a page, and
  no arbitrary React from a model. `custom_html` renders in a sandboxed
  iframe.
- **Display is read-only.** Writes go through a guarded mutation path in each
  widget's own idiom.
- **The container is the real jail.** `resolvePath()` is the in-process
  perimeter on top of it. A bug should be a bug, not a breach.

---

## Testing

```
208 source files · ~41,000 lines
126 test files  · ~19,000 lines
1,272 tests
```

CI runs typecheck, lint, the full suite, a UI build, and the container build
on every PR.

The tests are written against **failure modes, not coverage**. Each one
documents the bug it exists to prevent, and the load-bearing ones were
verified by reintroducing the bug and watching them fail. A representative
sample, all of which are real regressions this project shipped and fixed:

- the path jail refusing a symlinked component
- the iMessage reader unable to reach another conversation
- a scheduled run queueing an approval instead of blocking on it
- the session store measuring its history once per turn rather than twice
- a surface that cannot deliver a message not taking the host down with it

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
KOS_OWNER_DISCORD=      # your user id — the inbound gate

KOS_OWNER_IMESSAGE=     # your own handle; enables the iMessage surface
KOS_WORKSPACE=          # defaults to ~/kos-workspace
```

The iMessage surface is macOS-only and needs Full Disk Access (to read
`chat.db`) plus Automation permission for Messages. It reads exactly one
thread — your own — and stays off unless you name it.

### Running contained

```bash
docker compose up
```

The container is the strong jail and is mandatory for unattended cron. The
iMessage surface is the one exception: it needs host Messages.app and cannot
run inside it.

---

## Status

Actively built. The store, agent loop, channels, tools, memory, projects,
cron, operational spine, and UI are all in place, along with the conversation
and orchestration layers above them.

Known gaps, stated plainly: SMS is not implemented (Discord and iMessage are);
the module promotion path is specified but only one module exercises
instancing; PDF export is not built; and execution across conversations is
deliberately serial rather than parallel.

---

## License

Not yet licensed. Until a license file is added, default copyright applies
and no reuse rights are granted.
