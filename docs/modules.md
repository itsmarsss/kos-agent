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

## Whose tables are whose

The workspace database holds each project's tables, namespaced to its
slug, and KOS's own: conversations and transcripts, jobs, the approval
queue, the permission rules, memory, the audit log. A chat reaches the
tables of the project it belongs to through `sql` and `export.query`,
and nothing else: not another project's (a refusal says whose the table
is and to hand the question there), not KOS's own (read through the
tools for the job, `cron.list`, `chats.list` and `chats.read`,
`tasks.list`, `blobs.list`, `memory.recall`, `discord.threads`), and not
the schema itself (`sqlite_master`, `PRAGMA`). A chat with no project has
no tables; it asks KOS at the root, which routes the question to the
project that owns the data. Each turn's prompt lists its own project's
tables with their columns, so the model types names it has seen and
nothing it has not. The shell refuses a command line that names
`kos.sqlite` rather than asking you to let it through: the road around
the fence would otherwise be one yes away.

The guidance draws the line at ownership: your own table is your work,
read it and write it as the work needs; anything that looks wrong, a job
that failed, a table that is not what you expected, a count that makes no
sense, is handed to Maintenance (`chats.handoff` to
`@project:maintenance`) with what was seen, not investigated. Maintenance
is where KOS repairs itself and the one chat that browses: there `sql`
reads KOS's tables and every project's, and the schema, and writes with
your yes; the shell asks as for any command that writes; the trust tables
(approvals, permissions, the kill switch) are never written by a model
from anywhere. Its orchestrator carries a brief to match, and its answer
comes back to the chat that handed the matter over as a note.

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

### The browser

KOS drives a Chrome of its own, through @kos/browser (see
[browser.md](browser.md)); it is not an MCP server. `browser.visit` opens
a page and hands back a picture of it with an index of what can be acted
on, each control with a ref that stays the same while the page does;
`browser.act` runs a list of steps (click, fill, type, press, select,
check, hover, scroll, wait, back, a dialog's answer) and looks again;
`browser.look` looks without doing anything; `browser.eval` runs script in
the page. They share the site trust of the caller's tab: looking is safe,
acting asks until the site is trusted, and a script asks every time. Only
http and https pages open for an agent. What the page says is handed to
the model between markers that say so.

Chrome runs headless on DevTools port 9225, with its profile in
`.kos/browser-profile` under the workspace, one tab per conversation in a
window of its own. Settings > Browser has its window (shown or not), the
binary, unpacked extension folders (loaded at each start, Google Chrome
included) and the address bar's search; a change takes effect when Chrome
next starts. Sign-ins survive restarts: Chrome drops a cookie with no
expiry when it quits, so KOS gives each one an expiry of its own.

KOS's tab tools beside the visit and act: `browser.tabs` lists the open
tabs and whose each is, `browser.use_tab` moves the caller to one (the
owner's, or another agent's, which it then owns), `browser.new_tab` opens
a second one of its own. `browser.watch` reads a page (or one selector's
worth of it) and compares it with the last reading under the same name:
first look, no change since when, or the lines that went and came. With
`tell: true` a change is sent to the owner, so a watch is a scheduled job
of one fixed call and no model turn; the Schedule page's "Watch a page"
template writes it. A tab is one agent's at a time; an agent's tabs
close together when it idles out, and the owner's own are closed only by
the owner.

### Calendar and mail

Two picks under Settings > MCP servers: **google-calendar**
(`@cocal/google-calendar-mcp`) and **gmail** (`@artymclabin/gmail-mcp`).
Both use one Google OAuth client of your own, saved as
`google-oauth-client.json` in a `secrets` folder beside the settings file
(made when the pick is added; outside the workspace, and ignored by git),
where the tokens go too; the pick's note gives the exact one-time `auth`
command to run. Reading (events, free time, searching
and reading mail) is floored safe; creating, changing, answering,
sending, labelling or deleting asks. A morning brief job template under
Schedule reads both.

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

A script skill, once promoted, runs without asking: `skills.promote`
tests it in the sandbox and commits it, or asks you first when the code
reaches for something risky, and from then on `skills.run` of it is free.
Settings, Skills shows every skill, or one project's own, by kind or by
state, says which scripts are promoted, and opens each one's file; a
project's drawer lists its own. The Schedule page's Run a script template
schedules a promoted one as a fixed-calls job, no model turn.
That is how a job that needs no judgment is kept off the model: KOS writes
the script, you let it through once, and a schedule runs it as an actions
job calling `skills.run`, with no turn and no ask. A script reaches the
workspace database through `KOS_DB` and leaves what it found in a table;
the job's query reads that row, fresh before each action, and `{column}`
in a later action's arguments carries it, so one job can run the script
and then post what it produced. Switching the skill off in Settings stops
it; it stays promoted until it is removed.
