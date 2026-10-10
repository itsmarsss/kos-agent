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

Three ways to add one, all of which write that file:

```bash
kos mcp add browser --command "npx @playwright/mcp@latest"
kos mcp add mail --url https://mail.example/mcp --risk safe
kos mcp add --json '{"mcpServers":{"browser":{"command":"npx","args":["@playwright/mcp@latest"]}}}'
kos mcp list | enable <name> | disable <name> | remove <name>
```

The same from Settings, MCP servers: a name and a command line or URL, or
a block pasted from a README in Claude Code's `mcpServers` shape. A server
added while the host runs is brought up at once and the page says whether
it answered. Tools are risky until floored safe by name or glob in the
file's `tools` map; the Settings page shows the floors it has.

### The browser engine

The `browser` pick is agent-browser, run as an MCP server. Its environment
carries `AGENT_BROWSER_STREAM_PORT`, and that is how KOS knows which server
is the browser: the kernel attaches to the stream on that port to show the
live view and to pass your input through. Any engine that speaks the same
stream protocol could take its place by setting the same variable. Stream
quality and size are `AGENT_BROWSER_STREAM_QUALITY` and
`AGENT_BROWSER_STREAM_MAX_WIDTH`; `AGENT_BROWSER_HEADED=1` shows the
browser window on the machine as well.

## Installing skills

A skill is a folder under `skills/` with a `skill.json`, or a Claude Code
skill: a folder with a `SKILL.md` whose front matter names and describes
it, which KOS reads as a prompt skill and gives a `skill.json`.

```bash
kos skill install https://github.com/you/pdf-tables.git   # or a folder path
kos skill install ./my-skill --name receipts
kos skill update pdf-tables
kos skill remove pdf-tables
kos skill list
```

The same from Settings, Skills. Installed is off: a script from outside and
instructions from outside both wait for you to switch them on. A folder that
is not a skill is removed again, and the reason is said.
