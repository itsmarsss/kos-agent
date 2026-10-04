# KOS

**A personal agent with its own workspace, its own toolkit, its own memory,
and its own schedule. Runs on your machine, in one directory it cannot
leave.**

Ask it for a pantry tracker and it will design the schema, migrate the
database, write the page, serve it, schedule itself a weekly check, and
message you with buttons to log what ran out. Promote that tracker and it
becomes a module you can hand to someone else. Tell it something once and it
will remember, in words you can read and edit.

### By the numbers

| | |
| --- | --- |
| **17 tool families** | files, SQL, migrations, HTTP, shell, search, memory, projects, pages, sites, daemons, schedules, sub-agents, skills, modules, export, delegation |
| **1,506 tests** across 159 files | about 23,000 lines of tests for 49,000 of source |
| **291 pull requests** | all merged, all green |
| **5 surfaces** | web dashboard, terminal REPL, Discord, iMessage, SMS |
| **28 tables, 107 API routes** | one SQLite file, one local server |

**Stack:** TypeScript, Node 20, React, SQLite with vector search, Docker,
Anthropic, OpenAI or any OpenAI-compatible endpoint, Discord, Twilio,
AppleScript.

---

## The dashboard

Open `http://127.0.0.1:4317` and you land in a conversation. The sidebar is
the whole map:

| | |
| --- | --- |
| **Chats** | Where you talk to KOS. KOS at the top routes work across your chats; each project has a chat that orchestrates it; the agents a project spawns sit under it. A chip beside the composer says what memory the last turn was given. |
| **Inbox** | Everything waiting on you, in one list with the buttons to clear it: tool calls that need a yes, memory questions the tidy job could not settle, jobs failing now. The badge in the sidebar counts all three. |
| **Overview** | A dashboard you arrange: what needs you, what is running, what broke, memory at a glance, modules, projects, activity, recent chats, spend. |
| **Projects** | What KOS is keeping for you. A card opens the project's details: its tables, pages, sites, schedules, chat, folder and schema history. |
| **Files** | The workspace, browsed. |
| **Memory** | Claims, Decisions, Pages, Log, Jobs, Callers. See [docs/memory.md](docs/memory.md). |
| **Runs** | History (everything KOS has done), Schedule (the jobs and their editor), Agents (coding sub-agents). |
| **Settings** | Account, Conduct, Extensions, Access, Housekeeping. Models, keys, behaviour, appearance, skills, modules, permissions, network, spend, workspace. |

`⌘K` finds anything: a chat, a file, a page, a schedule, a setting, a
command. The full page-by-page guide is in
[docs/dashboard.md](docs/dashboard.md).

---

## A turn

```
 STARTED BY      you  ·  a schedule  ·  the agent itself  ·  a hook  ·  a caller
                                │
                                ▼
 ┌────────────────────────────────────────────────────────────┐
 │  AGENT LOOP    model  →  tool calls  →  results  →  repeat │
 │                with what memory recalled for this message  │
 └────────────────────────────────────────────────────────────┘
                                │
                                ▼
 ┌────────────────────────────────────────────────────────────┐
 │  EVERY CALL    risk tier  →  approval if risky  →  audited │
 └────────────────────────────────────────────────────────────┘
                                │
                                ▼
 ┌────────────────────────────────────────────────────────────┐
 │  WORKSPACE     tools · SQLite · files · sites · daemons    │
 │                one directory, and no path may leave it     │
 └────────────────────────────────────────────────────────────┘
```

Conversations run in parallel, one lane each: a follow-up in a chat waits
behind that chat's turn and nothing else. Scheduled jobs and dispatched
turns have lanes of their own.

---

## What it does on its own

**Prompts itself.** A self-prompt schedule hands the agent an instruction and
lets it decide what to do with it. Each job names its model class, reasoning
or cheap.

**Delegates.** KOS, the root conversation, dispatches work to project chats.
A project chat spawns conversations for its work and sees only its own. A
spawned conversation cannot spawn, so delegation is bounded.

**Runs sub-agents.** Larger builds go to a Claude Code sub-agent working in
one folder of the workspace. Chat turns can run on your Claude subscription
the same way, with KOS's own tools and nothing else.

**Remembers.** Every exchange is logged. What KOS believes is a claim, scoped
to a project or global, with the evidence it came from. Three jobs maintain
it, each off until you switch it on. [docs/memory.md](docs/memory.md).

**Looks around.** A heartbeat, off by default, wakes on an interval you set,
checks what changed, and says nothing unless something is worth saying.

**Answers a hook.** `POST /api/hooks/<job name>` with the hook secret starts
the named job, and nothing else.

**Supervises daemons.** Programs it spawns are restarted with backoff.

**Extends itself.** Skills are sandbox-tested in a child process against a
throwaway database copy, then promoted if safe or queued for your approval.
Modules it writes do not run until you switch them on.

**Promotes what it built.** A project can become a blueprint module: its
schema, pages and jobs, none of its data. A new instance is a new project
from it. [docs/modules.md](docs/modules.md).

---

## Constraints

| | |
| --- | --- |
| **Path jail** | One `resolvePath()` gate. Rejects `..`, NUL bytes, absolute escapes, and all symlinks |
| **Container** | The container is the jail for unattended work. On macOS a sandbox profile confines shell commands to the workspace |
| **Risk tiers** | A static floor per tool, escalated deterministically by arguments. The model is never asked whether something is safe |
| **Approvals** | Interactive turns suspend and resume on your decision. Scheduled runs queue the action and finish. A decision remembered with Always covers that shape, in that project, and nothing wider |
| **Schema changes** | A guarded `migrate` primitive: versioned, git-snapshotted, restorable |
| **Audit** | Every call logged with arguments, result, risk tier, caller |
| **Secrets** | Held outside the workspace, referenced by name, injected at call time, redacted from logs. Child processes get an allow-listed environment |
| **Outside code** | MCP servers and workspace modules are risky by default; you floor tools safe one at a time, by name or glob. The harness never guesses a tool is safe |
| **One owner** | iMessage reads one thread, SMS answers one number, Discord one account. A stranger is dropped, never answered |

Nothing in the repository holds a credential, a phone number or a handle.
Those live in `.env`.

---

## Quick start

Node 20 or newer, and pnpm.

```bash
pnpm install
pnpm build              # TypeScript + UI assets
cp .env.example .env    # set at least one model key
pnpm doctor             # preflight
pnpm start              # API + dashboard + cron + channels
```

Open `http://127.0.0.1:4317`, or attach a REPL with `pnpm kos`.

`pnpm start` leaves a detached process. On macOS, `pnpm kos service install`
makes the host a launchd agent that restarts after a crash and starts at
login; `kos service status` says which is running. For unattended use
anywhere else, `docker compose up` runs the host in the container that is its
jail.

Then, in Settings:

1. **Models.** Which model answers, which one is cheap, and where builds run.
   Any OpenAI-compatible endpoint works as the custom provider.
2. **Behaviour.** Whether KOS tries to fix its own failures, how hard it
   tries, and the budget for unattended work.
3. **Memory, Jobs.** Switch on Read, Tidy and Condense when you are ready
   for KOS to maintain its own memory.

[docs/configuration.md](docs/configuration.md) lists every setting and
variable. [docs/channels.md](docs/channels.md) covers Discord, iMessage, SMS
and hooks.

---

## Connecting from outside

`@kos/client` is a typed, dependency-free client for a running host: a turn
in a project's conversation, the shared memory, approvals, modules, a job's
hook. Another program borrows KOS rather than carrying an agent of its own.

```ts
import { KosClient } from "@kos/client";

const kos = new KosClient({ baseUrl: "http://127.0.0.1:4317", token: process.env.KOS_DASHBOARD_TOKEN });
const { reply } = await kos.ask("resume-ops", "tailor the summary to this posting: ...");
```

A **caller** is another program with its own token and its own corner of
memory, made under Memory, Callers. It reads your global claims only under
the tags you grant. `kos memory-mcp --token kosc_...` serves that grant as an
MCP server to Claude Code or any agent that takes one.

---

## Architecture

| Package | Role |
| --- | --- |
| `packages/harness` | The kernel: agent loop, jail, store, tools, cron, memory, channels, modules, ops |
| `packages/ui` | The dashboard: a React shell that also renders agent-authored page specs |
| `packages/cli` | The `kos` command: host, REPL, service, modules, evals, doctor |
| `packages/client` | `@kos/client` and the caller client |
| `packages/shared` | Contracts both sides import |

- **The kernel is primitives; a feature is a module.** Files, SQL, shell,
  HTTP, search, memory, schedules, daemons, delegation, skills, MCP are the
  kernel. Tasks, sites, export and builds are built-in modules you can switch
  off. Everything else is a folder under `modules/`.
- **Modules compose through shared surfaces**: the workspace, the tool
  registry, the project manifest, and the event bus. Never through each
  other.
- **Conversations are the unit of work**, each with a brief and a tool
  allow-list set by you.
- **SQLite only.** One workspace file, JSON columns for documents,
  `sqlite-vec` for embeddings.
- **The agent emits JSON, not React.** Page specs render through a fixed
  library of eight widget kinds; `custom_html` renders in a sandboxed frame.

---

## Testing

Tests are written per failure mode, and the load-bearing ones were checked
by reintroducing the bug and watching them fail: the path jail refusing a
symlinked component, the iMessage reader reaching another conversation, a
scheduled run blocking on an approval, the orchestrator calling a tool it was
not granted, an undeliverable message taking down the host, a second
instance's tables being claimed by the first.

CI runs typecheck, lint, the suite, a UI build and the container build on
every pull request.

---

## Status

Everything in the build order is in place: store and jail, agent loop and
router, channels, tools with risk tiers and the sandbox, memory, the project
builder, cron with the container jail, the operational spine, the dashboard.
Above it: conversations and orchestration, the memory system, callers and
the client, workspace modules with blueprints and git distribution, module
events, the subscription engine, SMS, PDF export.

Deferred by design: voice and telephony; multi-user beyond the identity seam.
Not verified against live accounts: SMS (needs a Twilio account and a public
URL) and the external classifier endpoint.

---

## License

Apache-2.0. See `LICENSE`.
