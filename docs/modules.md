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

KOS's own `browser.visit` (open a page and get what is on it, in one call)
and `browser.act` (a run of clicks, fills and keys, then the page after)
are made of the engine's tools and run on the caller's tab; they share its
site trust, and `browser.act` asks like any other action until the site is
trusted. The engine hands pages to the model capped
(`AGENT_BROWSER_MAX_OUTPUT`) and wrapped in content boundaries, so page
text is marked as the page's.

KOS runs one Chrome of its own, headless, on the DevTools port named by
`AGENT_BROWSER_CDP` in the `browser` pick's environment (9225). The engine
(agent-browser) attaches to that Chrome over CDP, one session per
conversation, pinned to a tab KOS makes for it in a window of its own, so
every agent's page paints at once and the live view can show any of them.
That environment variable is also how KOS knows which server is the
browser; any engine that attaches over CDP could take its place. KOS's own
keys beside it: `KOS_BROWSER_VIEWPORT` (`1600x1000`), the size each tab is
set to through the engine's viewport tool; `KOS_BROWSER_CHROME`, a binary
to run instead of the first one found; `KOS_BROWSER_HEADED=1` to show the
window on the machine as well; `KOS_BROWSER_EXTENSIONS`, unpacked
extension folders (comma or newline separated) passed as
`--load-extension`, which Google Chrome 137 and later ignores in its own
builds while Chromium and Chrome for Testing honour it; and
`KOS_BROWSER_SEARCH`, where the dashboard's address bar sends words, a
URL with `%s` (DuckDuckGo by default). Settings > Browser edits these
four. Logins and installed extensions live in `.kos/browser-profile`
under the workspace and survive restarts. A change to a server's entry
(command, args, env, floors) takes effect on the next reload from
Settings; the server is brought up again with the new one. The KOS keys
take effect when Chrome next starts (Restart the browser in Settings). A
changed port wants a host restart.

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
