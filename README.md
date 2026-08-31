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

## Run (multi-modal host)

One background process owns the Kernel, Discord, cron, and dashboard API.
CLI attaches to it so DMs and `kos` share the same session and memory.

```bash
# 1. Start the host (detaches; Discord if token+owner are in .env)
pnpm start
# or: node packages/cli/dist/main.js start

# 2. Attach CLI (same brain as Discord)
pnpm kos
# or: pnpm kos once "hi"

# 3. Restart after rebuilding or changing .env
pnpm run restart
# note: `pnpm run restart`, not `pnpm restart` -- the latter is pnpm's own
# lifecycle command and shadows this script

# 4. Stop when done
pnpm stop
```

Also:

```bash
pnpm kos status | memory | pages | doctor
pnpm start --foreground    # keep host in this terminal
pnpm start --no-discord    # API + cron only
kos restart                # stop, wait for the port, start again
kos discord                # host foreground, require Discord creds
```

Workspace defaults to `~/kos-workspace`. Session id is `primary:owner` for
CLI and Discord. Facts/memory are shared either way.

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
