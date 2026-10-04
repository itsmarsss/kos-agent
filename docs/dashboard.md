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

## Inbox

Everything waiting on you: tool approvals (with a link to the chat that
asked), memory decisions (keep one side, both, promote, dismiss), and jobs
failing now (open, put KOS on it, dismiss). The sidebar badge counts all
three.

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
  everything lives, halt and resume).

## Phone width

The sidebar is a drawer behind the menu button. Chats show one pane at a
time: the list until a chat is open, then the chat, with the list a drawer
from the toggle beside the title.
