# Modules

The kernel is primitives. A feature is a module.

## Built-ins

Tasks, sites, export and builds ship with the kernel and switch off under
Settings, Modules. Off takes their tools away at once.

## Workspace modules

A folder under `modules/` with a `module.json`. Two kinds, which may be
combined:

**A server.** The manifest names a program; KOS runs it from its own folder,
inside the jail, speaking the Model Context Protocol, and its tools register
as `mcp.<module>.<tool>`:

```json
{
  "name": "notes",
  "description": "Short notes with tags, searchable",
  "command": "node",
  "args": ["server.mjs"],
  "tools": { "notes_search": "safe", "notes_list": "safe" },
  "projects": ["journal"]
}
```

Tools are risky unless the manifest floors them safe. `projects` scopes the
module: its tools exist only in those projects' conversations. KOS can write
one with `modules.create`, which scaffolds a dependency-free server. Nothing
runs until you switch it on.

**A blueprint.** A project template: the schema (as the migrator's own list
of changes), the pages and the jobs, with the project's slug replaced by
`{{instance}}`, and none of the data.

```json
{
  "name": "pantry-tracker",
  "description": "A pantry stock tracker",
  "blueprint": { "type": "tracker", "instancing": "multi", "schema": [...], "pages": [...], "jobs": [...] }
}
```

A new instance is a new project made from it: the schema replayed under the
new slug, the pages written for it, its jobs made and left off. Make one
under Settings, Modules, or with `modules.instantiate`. A module with both
a server and a blueprint has its tools scoped to its instances.

## Promotion

A project KOS built in place becomes a blueprint with `modules.promote`.
It is a risky tool, so it stops for your approval: promotion is
user-initiated, never automatic. The project becomes the first instance. A
table made outside the migrator has its columns read from the database and
is reported as derived.

## Distribution

A module is a folder. Share it by handing the folder over, or publish it as
a git repository:

```bash
kos module install https://github.com/you/kos-notes.git   # or a folder path
kos module update notes
kos module remove notes
kos module list
```

The same from Settings, Modules. Installed is off; the manifest is checked
and a folder that is not a module is removed again.

## Events

The kernel tells modules what happens: a turn starting or ending, a tool
ending, an approval requested or decided, a job firing, a module switched.
An in-process module subscribes through its context; the subscriptions end
when it is switched off. The heartbeat is a module built this way.

## MCP servers that are not modules

`mcp.json` at the workspace root declares servers the way Claude Code does.
A browser, mail, anything with an MCP server. Same floors, same jail, same
`{{secret:NAME}}` injection. A browser runs its own profile inside the
workspace, never your logged-in one, and KOS never enters a password or a
payment detail.
