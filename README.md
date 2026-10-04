# KOS

**An AI agent with its own workspace, its own toolkit, and its own schedule.**

Ask it for a reading tracker and it will:

1. design a schema and migrate the database
2. write the pages and serve the site on its own port
3. schedule itself a daily check
4. message you at noon with buttons to log progress

It runs on your machine, in one directory it cannot leave.

### By the numbers

| | |
| --- | --- |
| **84 tools** in 16 families | files, SQL, migrations, HTTP, search, memory, projects, sites, daemons, schedules, sub-agents, skills |
| **1,272 tests** across 126 files | ~19,000 lines of tests, ~41,000 of source |
| **239 pull requests** | all merged, all green |
| **4 surfaces** | Discord, iMessage, web dashboard, terminal REPL |
| **21 tables, 70 API routes** | one SQLite file, one local server |

**Stack:** TypeScript, Node 20, React, SQLite with vector search, Docker,
Anthropic and OpenAI, Discord API, AppleScript.

---

## A turn

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

---

## What it does on its own

**Prompts itself.** A `self_prompt` schedule hands the agent an instruction
and lets it decide what to do with it.

**Delegates.** An orchestrator conversation dispatches work to other
conversations, each with its own brief and tool allow-list. Dispatched
conversations do not hold the dispatch tools, so delegation is one level deep.

**Runs sub-agents.** Larger builds go to a Claude Code sub-agent whose working
directory is a folder inside the workspace.

**Reads its own toolkit.** `tools.list` returns everything available,
including tools narrowed out of the current turn.

**Supervises daemons.** Programs it spawns are restarted with backoff.

**Answers a hook.** With `KOS_HOOK_SECRET` set, `POST /api/hooks/<job name>`
with that secret as a bearer token starts the named job. The secret opens
nothing else, the body is ignored, and the run reports to health like a
scheduled one.

**Writes its own memory.** A salience heuristic decides what persists. Recall
is semantic via `sqlite-vec`, with literal search as the fast path.

**Extends itself.** New skills are sandbox-tested in a child process against a
throwaway database copy, then promoted automatically if safe, or queued for
approval if not.

---

## Constraints

| | |
| --- | --- |
| **Path jail** | One `resolvePath()` gate. Rejects `..`, NUL bytes, absolute escapes, and all symlinks |
| **Risk tiers** | Static floor per tool, escalated deterministically by arguments. The model is not consulted |
| **Approvals** | Interactive turns suspend and resume on the decision. Scheduled runs queue the action and finish |
| **Schema changes** | Guarded `migrate` primitive: versioned, git-snapshotted, restorable |
| **Skills** | Sandbox-tested before promotion |
| **Audit** | Every call logged with arguments, result, risk tier, caller |
| **Secrets** | Held outside the workspace, referenced by name, injected at call time, redacted from logs. Child processes get an allow-listed environment |

### Reading iMessage

Apple's `chat.db` holds every conversation on the machine. The reader binds
every query to a single conversation in the SQL itself, and no code path
constructs a statement without that binding.

It is tested against a fixture containing other people's messages.

### MCP servers

Tools from Model Context Protocol servers are offered like any other tool.
A server is declared in `mcp.json` at the workspace root, in the shape Claude
Code uses, and each tool it lists registers as `mcp.<server>.<tool>`.

A server's tools are **risky** by default: it is someone else's code, and the
harness classifies it rather than trusting it. `"risk": "safe"` lowers the
whole server; a `"tools"` map floors tools one at a time, by name or glob, so
a read-only tool can be safe while a mutating one stays risky. The harness
never guesses a tool is safe.

```json
{
  "servers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--isolated",
               "--user-data-dir", "projects/browser-profile"],
      "risk": "risky",
      "tools": {
        "browser_navigate": "safe", "browser_navigate_back": "safe",
        "browser_snapshot": "safe", "browser_find": "safe",
        "browser_take_screenshot": "safe", "browser_wait_for": "safe",
        "browser_console_messages": "safe", "browser_network_requests": "safe"
      }
    }
  }
}
```

The browser runs its **own profile inside the workspace** (`--user-data-dir`
under a project, `--isolated` so each run starts clean), never the owner's
logged-in Chrome. Anything that changes a page (click, type, fill a form)
stays risky and asks, or runs under a remembered permission. KOS never enters
a password or payment detail; the owner signs into a site once in KOS's own
profile.

`{{secret:NAME}}` in a server's `env` or `headers` is injected at connect and
never logged. A server that fails to start is reported and skipped. Stdio
servers are child processes that do not outlive the host.

### Mail

Mail is an external service, so it comes in the same way. An IMAP server
works with any provider and keeps sending off until it is switched on:

```json
{
  "servers": {
    "mail": {
      "command": "npx",
      "args": ["-y", "@aiwerk/mcp-server-imap"],
      "env": {
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "you@example.com",
        "IMAP_PASS": "{{secret:mail}}"
      },
      "tools": {
        "email_list": "safe", "email_read": "safe", "email_search": "safe",
        "email_folders": "safe", "email_attachment": "safe"
      }
    }
  }
}
```

The password is `KOS_SECRET_MAIL` in `.env`, an app password rather than
the account's own. Reading is floored safe, so the heartbeat can look at
what arrived without asking. Moving, flagging, deleting, sending and
replying stay risky: each asks, or runs under a permission the owner
remembered for that tool. Sending also needs the server's own opt-in,
`SMTP_SEND_ENABLED=true` with `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and
`SMTP_FROM` in `env`. A Gmail-specific server with OAuth fits the same
shape; what changes is the tool names in the floors map.

---

## Architecture

| Package | Role |
| --- | --- |
| `packages/harness` | Kernel: agent loop, jail, store, tools, cron, memory, channels, ops |
| `packages/ui` | React shell rendering agent-authored page specs |
| `packages/cli` | The `kos` command: REPL, host, ops, doctor |
| `packages/shared` | Contracts both sides import |

- **Conversations are the unit of work.** Each carries a brief and a tool
  allow-list, set by the owner rather than by the agent.
- **Execution is serial.** Conversations are parallel as threads, not as
  running work. A lane-based queue keeps same-lane calls ordered.
- **SQLite only.** One workspace file, JSON columns for documents,
  `sqlite-vec` for embeddings.
- **The agent emits JSON, not React.** Page specs render through a fixed
  library of 8 widget kinds. `custom_html` renders in a sandboxed iframe.
- **The container is the jail.** `resolvePath()` is the in-process perimeter
  on top of it.

---

## Testing

Tests are written per failure mode. The load-bearing ones were checked by
reintroducing the bug and confirming they fail.

Regressions with dedicated tests:

- the path jail refusing a symlinked component
- the iMessage reader reaching another conversation
- a scheduled run blocking on an approval instead of queueing it
- the orchestrator calling a tool it was not granted
- an undeliverable message taking down the host

CI runs typecheck, lint, the suite, a UI build and the container build on
every pull request.

---

## Quick start

Node >= 20 and pnpm.

```bash
pnpm install
pnpm build:all          # TypeScript + UI assets
cp .env.example .env    # set at least one model key
pnpm doctor             # preflight
pnpm start              # API + dashboard + cron + channels
```

Open `http://127.0.0.1:4317`, or attach a REPL with `pnpm kos`.

### Configuration

`.env` is git-ignored; `.env.example` documents every key.

```bash
ANTHROPIC_API_KEY=      # preferred when both are set
OPENAI_API_KEY=         # works alone; the router falls back

KOS_SECRET_DISCORD=     # bot token
KOS_OWNER_DISCORD=      # your user id, and the inbound gate

KOS_OWNER_IMESSAGE=     # your own handle; enables the iMessage surface
KOS_WORKSPACE=          # defaults to ~/kos-workspace
```

iMessage is macOS only. It needs Full Disk Access and Automation permission
for Messages, reads one thread, and stays off unless configured.

### Contained

```bash
docker compose up
```

Required for unattended cron. iMessage is the exception: it needs the host's
Messages.app.

---

## Status

The agent loop, store, channels, tools, memory, projects, cron, operational
spine and UI are in place, with the conversation and orchestration layers
above them.

Not built:

- SMS (Discord and iMessage are)
- the module promotion path, beyond one module using instancing
- PDF export
- parallel execution across conversations, which is deliberate

---

## License

Apache-2.0. See `LICENSE`.
