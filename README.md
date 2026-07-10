# KOS

A sandboxed, file-system-native AI agent. It owns a workspace directory,
manages arbitrary structured projects, logs everything, and stays easily
retrievable. A personal, self-hosted agent scoped to a single workspace,
reachable through messaging channels and a dynamic UI.

## Layout

pnpm workspaces monorepo:

- `packages/shared` - types and contracts shared across harness and UI
- `packages/harness` - kernel: store, jail, agent loop, tools, cron, memory
- `packages/cli` - the `kos` command (REPL, ops, Discord, dashboard)
- `packages/ui` - fixed React shell, widget library, page-spec renderer

## Setup

Requires Node >= 20 and pnpm.

```bash
pnpm install
pnpm build:all          # TypeScript + UI static assets
cp .env.example .env    # set at least one model key
pnpm doctor             # preflight
```

`.env` (auto-loaded by the CLI):

```
ANTHROPIC_API_KEY=...   # preferred when present
OPENAI_API_KEY=...      # works alone (router falls back)
# Discord:
KOS_SECRET_DISCORD=...  # or DISCORD_TOKEN=
KOS_OWNER_DISCORD=...   # or DISCORD_OWNER_ID=
# Optional:
KOS_WORKSPACE=~/kos-workspace
KOS_DASHBOARD_TOKEN=... # required for mutating API if not on loopback only
KOS_HOST=127.0.0.1
KOS_PORT=4317
```

## Run

```bash
pnpm kos                # interactive REPL
pnpm kos once "hi"      # one-shot chat (session + memory)
pnpm kos status
pnpm kos memory
pnpm kos pages
pnpm kos doctor
pnpm serve              # dashboard API + static UI on 127.0.0.1:4317
pnpm kos discord
```

Also: `node packages/cli/dist/main.js <cmd>`.

Workspace defaults to `~/kos-workspace`. Chat keeps multi-turn history,
loads salient memory into context, and writes durable facts on the way out.

### Dashboard

`pnpm serve` binds loopback by default and serves the built UI when
`packages/ui/dist` exists. Open http://127.0.0.1:4317

- Control tower: status, approvals, projects, pages, crons, kill switch, prompt
- Agent pages: `#/page/<id>` with live read-only display queries

Dev UI alternative: `pnpm serve` + `pnpm -C packages/ui dev` (proxies `/api`).

### Docker jail

```bash
docker compose up --build
```

Mounts `./workspace` (or `KOS_HOST_WORKSPACE`) at `/workspace` only. Env from
`.env`. Publish is loopback-only in compose.

## Agent capabilities (first-party modules)

- files, sql, search, notify, http.fetch, cron
- systems: project_create, project_list, migrate, pages.write/list/get
- tasks: multi-instance lists (create_list, add, list, complete) + page-spec

Risky tools (sql writes, migrate, http, cron.schedule, tasks.create_list, …)
go to the approval queue.

## Develop

```bash
pnpm build
pnpm test
pnpm lint
```
