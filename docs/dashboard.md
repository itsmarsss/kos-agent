# The dashboard, page by page

The sidebar is the map. `⌘K` opens search and commands from anywhere.

## Chats

Opening KOS opens a conversation. With nothing open, the landing is a
composer: type, press Enter, and a chat is made, your message sent, the turn
under way. Shift+Enter is a newline.

The list on the left:

- **KOS** routes work across your chats. Ask it for something that belongs
  in a project and it hands the work on.
- **A project row** is that project's own chat, its orchestrator. Under it,
  the agents it spawned, busy ones first. The row says how many agents and
  whether one is working; the chevron folds them away.
- **Scheduled** holds the threads jobs run in, folded by default.
- **Your chats**, newest first. Hover a row for Rename, Duplicate, Archive,
  Delete (two presses).
- **Archived**, at the foot, is where archived chats go. Archive from a
  chat's header gives you eight seconds to undo.

In a chat:

- The header says where it sits: an agent names its project, a project
  chat says it orchestrates the project.
- **Configure** sets the chat's brief (standing instructions, added to the
  system prompt for this chat only) and which tools it may use. A scoped
  chat is told its own limits so it says "not here" rather than improvising.
- `@` references a project, page, file, schedule, chat, site or agent.
  `/` opens commands: `/new`, `/chats`, `/switch`, `/rename`, `/archive`,
  `/compact`, `/clear`, `/tools`, `/help`.
- Beside the composer: the model, how full the conversation is, and a chip
  that says what memory the last turn was given. Open it to see each claim
  with its scope and the log moments that came along.
- A tool call that needs a yes shows Approve, Always and Deny in place.
  Always remembers the decision for that shape in that project.

## Browser

KOS browses the web through one real Chrome, a tab per agent, and you can
watch any of them. The sidebar's **Browser** opens a window with a strip of
the open tabs and whose each is; the one you pick streams live as that
agent moves, the title line says what it is doing, and the window opens on
its own the first time a turn uses the browser (close it, and it stays shut
for that turn). The working agent's tab is shown first. Drag the header to
move it, pull an edge to resize it; it remembers where it was. Maximize
fills the page (double-click the bar does the same), Full screen takes the
whole screen, and when the browser has several tabs a strip under the bar
says which one you are looking at. The page is rendered at 1600 by 1000 and
drawn at your screen's own pixel density, so it reads at any size.

`⌘⇧B` shows and hides the window. **Following** keeps it on whoever is
working; pick a tab yourself and it is **Pinned** until you say follow
again. Each browser step in a thread keeps a small picture of the page as
the agent left it, under its card; click it to see it large. That is the
record of what a reply was looking at.

**Your own tabs.** The strip ends in a **+**: a tab of your own, nobody's
until you send an agent to it. Under the strip is an address bar with
back, forward and reload beside it: type an address and it goes there,
type words and they are searched (DuckDuckGo unless Settings > Browser
says otherwise), press Enter with no tab open and one is made. Every tab
has an **x**; closing an agent's gives it a fresh one on its next step.
Your tabs are dashed in the strip and are never closed for being idle.

**Pointing an agent at a page.** Type `@tab:` in any chat and the picker
lists the open tabs by their page, with whose each is. The agent is told
what the tab shows and takes it over with `browser.use_tab`, so "look at
@tab:… and tell me what it says" works on a page you opened yourself, or
on another agent's. The chip in the thread opens the window on that tab.
Agents can list tabs (`browser.tabs`) and open a second one of their own
(`browser.new_tab`); an agent's tabs all close together when it idles out.

**Settings > Browser** runs the Chrome: show its window on this machine
(headless otherwise), which binary to run, unpacked extension folders,
and the address bar's search. Extensions live in KOS's own profile and
stay. The sure way to install one is to show the window, open
`chrome://extensions` (there is a button for it), and use the Web Store
or Load unpacked; the folders list uses Chrome's `--load-extension` flag,
which Google Chrome 137 and later ignores while Chromium and Chrome for
Testing honour it. **Restart the browser** applies a change; every tab
goes with it.

A file an agent downloads lands in its project, under `downloads`, with the
name the site gave it (or in a `downloads` folder at the workspace root for
a chat with no project), and the thread says so with a file card. Tabs
nobody has used for twenty minutes are closed; an agent that comes back
gets a fresh one. `browser.look` lets an agent see its tab as a picture
when the snapshot is not enough; the picture goes to the model, not just
to you.

**Take over** gives you that tab: your clicks, scrolling and typing go to
it instead of to the dashboard, with the window's border lit to say whose
hand is on it. **Let go** hands it back. The agent does not stop while you
drive; it reads the page again on its next step.

**Sign in with your hands.** When an agent reaches a login, a code, a
captcha or a payment, it asks for your hands rather than guessing. The
window opens on that tab with the ask across the top: Take over, do the
thing, then **Done**. The agent's turn waits for you and carries on with
the page as you left it; logins stay in the browser's profile, so every
agent is signed in from then on. **Can't** sends it back empty-handed.
The same ask sits in the Inbox with an "Open the browser" button.

The engine is an MCP server (`agent-browser`, under Settings › MCP servers,
one click from the picks). Looking is safe by default: opening a page,
reading it, scrolling, switching tabs. Acting asks you first: clicks,
typing, form fields, running script. The approval shows a picture of the
page the action is aimed at and names the site. **Always** on one of those
trusts that site for every browser action from then on (running script in
the page is the exception and always asks); the rule shows under Settings
› Permissions as `mcp.browser.*` on `site:<host>`, revocable like any
other. Change the floors per tool there if you want it to act on its own
everywhere.

## Inbox

Everything waiting on you: tool approvals (each quoting what KOS said
just before it asked, with a link to the chat that
asked), memory decisions (keep one side, both, promote, dismiss), and jobs
failing now (open, put KOS on it, dismiss). The sidebar badge counts all
three. A job has one fix chat, under Maintenance: when it fails again,
KOS goes on in that chat with what it found last time rather than
opening another.

An approval does not wait forever. A turn holds for the minutes Settings >
Behaviour gives it and then treats the silence as a refusal; the ask
lapses with it. An ask nobody is waiting on, from a scheduled job or from
a turn a restart cut, keeps for the hours set there (a day by default) and
then lapses too. Either way it leaves the Inbox, the prompt for it on
Discord or iMessage settles as lapsed, and the chat that asked is told
nothing was done. Each card says when it lapses.

## Overview

Panels you arrange with the Arrange button: Needs you, Agents, What broke,
Memory, Modules, Projects, Activity, Chats, Schedule, Spend, Note. Each
answers one question and says so when the answer is nothing.

## Projects

A card per project with its pages as chips. Click the card for details:
rows and tables, pages, sites, schedules, status, type, which module it came
from, its chat, its folder, and the schema history. A project made from a
blueprint says so.

## Files

The workspace as a browser. Folders, files with a preview, filter and sort.

## Memory

Six tabs. See [memory.md](memory.md) for what each holds.

## Runs

- **History**: everything KOS has done, newest first. Filter to tools, runs
  or failures. A row opens its full record; a failure has Fix, which opens a
  chat with KOS on it.
- **Schedule**: the jobs. A row opens the editor: name, when (with presets),
  what it does (Ask KOS with a prompt and a model class, or fixed tool
  calls), Run now, Pause, Delete. The built-in backup has no actions to edit.
  A new job can start from a template: **Morning brief** (weekdays at
  7:30: today's calendar, mail that needs an answer, what KOS has planned,
  sent to you with notify), **Weekly review** (Mondays at 8), or **Watch a
  page** (every six hours: the browser reads the page, keeps what it said,
  and tells you which lines changed, with no model turn). The brief
  reads your calendar and mail once those servers are added under Settings
  > MCP servers (the Google Calendar and Gmail picks, each with a one-time
  sign-in step it spells out), and until then says what it could not read.
- **Agents**: coding sub-agents, each confined to one folder. New agent asks
  for the folder and the task.

## Settings

Grouped by what you came to do.

- **Account**: You (name, timezone), Providers (keys, shown by their last four
  characters), Models (engine, which model answers each class, the custom
  endpoint, the classifier).
- **Conduct**: Conversation (history budget, exchanges kept, tool result
  cap), Behaviour (fix failures on its own, steps per turn, unattended
  limits, background memory extraction), Appearance (dark, light or system;
  density).
- **Extensions**: Skills (on by default; off keeps the folder), Modules
  (built-ins to switch, workspace modules to switch on, blueprints with
  their instances, install from a git URL or folder).
- **Access**: Permissions (every Always you said, revocable), Network (ports,
  bind address, hosts the agent may fetch).
- **Housekeeping**: Spend (tokens by model, rates), Workspace (where
  everything lives, halt and resume, and Restart KOS: the host restarts
  once no chat is mid-turn and no coding agent is running, so nothing is
  cut; the page says what it is waiting on, and Cancel takes it back).

## Phone width

The sidebar is a drawer behind the menu button. Chats show one pane at a
time: the list until a chat is open, then the chat, with the list a drawer
from the toggle beside the title.
