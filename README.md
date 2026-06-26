# KOS

A sandboxed, file-system-native AI agent. It owns a workspace directory,
manages arbitrary structured projects, logs everything, and stays easily
retrievable. A personal, self-hosted agent scoped to a single workspace,
reachable through messaging channels and a dynamic UI.

## Layout

pnpm workspaces monorepo:

- `packages/shared` - types and contracts shared across harness and UI
  (skill contract, page-spec schema).
- `packages/harness` - the operational core: store, jail, agent loop, model
  router, tools, cron, memory, operational spine.
- `packages/ui` - the fixed React shell, widget library, and page-spec
  renderer.

## Develop

```
pnpm install
pnpm build       # tsc -b across all packages
pnpm typecheck   # tsc -b
pnpm test        # vitest
pnpm lint        # eslint
```

Requires Node >= 20 and pnpm.
