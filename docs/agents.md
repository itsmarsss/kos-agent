# Agents

A standing agent is a responsibility KOS keeps for you. "Keep an eye on this
listing", "handle my travel", "every Saturday, plan the evening": each needs
somewhere to live between asks, and that is what an agent is. KOS makes one
from the sentence; nothing about it is code, and nothing is written for any
one job. The shopper, the researcher and the Saturday planner are the same
four tools with different briefs.

## What one is

A folder of its own, `agents/<name>/`, with a file `agent.md` in it that you
can read and edit. The rest of the folder is the agent's: it is told to keep
its notes and anything it makes there, the way a project keeps its files
in its own folder. The file:

```
---
name: price-watch
description: Watches one listing and says when it drops
tools: browser, memory
memory: own
task: cheap
schedule: 0 */6 * * *
prompt: Look at the listing and compare with what you remember.
---

You watch one Walmart listing for the owner. Keep the last price you saw in
memory. When it drops below the target, tell the owner once, with the link.
Never buy anything; that is the owner's press.
```

The head says what it may reach and when it runs; the body is its brief.

- `tools`: tool families it may use (`browser`, `memory`, `files`, ...).
  Absent is the full toolkit. KOS leaves this unset unless you asked to
  limit the agent.
- `memory`: `own` (the default) gives it a scope of its own, `agent:<name>`,
  read in its turns beside your global claims, so its working notes stay
  its own. `shared` is the ordinary rule: the project it is in, or global.
- `task`: `reasoning` (the default) or `cheap`, which model class answers.
- `schedule` and `prompt`: a cron expression and what it is told on each
  run. Without a schedule it works only when dispatched or spoken to.

KOS reads the file on every turn, so an edit is the next turn's brief. A
file that does not parse is listed as invalid with the reason, and its
thread carries on with what it had.

## Its face

Each agent has a face: a flat blob with two eyes and a small smile, whose
colour, silhouette, gait and eyes come from its name, so it looks the same in the rail, on its page, in
a chat header and in an `@agent:` chip, and no two look alike by accident.
It is alive rather than animated: one smooth shape that breathes, squashes
when you hover, wobbles like jelly when poked and settles, fidgets now and
then, looks at your cursor and leans in when you are close, blinks, and
grins with its eyes. The face says what it is doing: it glances
about while working, hops with a mark when it needs you, sags with slanted
eyes on an error, and sleeps when its schedule is paused. With reduced
motion on, it holds still.

Any of it can be set by hand, in the file (`face: hue 210, eyes sparkle,
gait 2`, or `colour #3b82f6` for any colour at all; hue 0 to 359, eyes
round, half or sparkle, gait 0 to 3) or in Edit on the agent's page: a row
of colours to pick from, and Custom, which opens a picker of the page's
own (a square and a hue strip, with the hex) for any other. A picked colour
is the body as you chose it; its hue colours the accents around the agent,
and the eyes go pale on a dark body so they still show. The eyes and gait
are choices; what is left unset still comes from the name. KOS has a face of the same kind, in the sidebar, the
chat rail, the landing and the tab icon, set under Settings, Appearance.

## Where it lives

Each agent has one standing thread, `agent:<name>`, on the agent's own page
under Agents, not in the Chats tab. Talk to it there as you would to any
chat, or from Discord, iMessage or SMS by starting a message with its name
(`@recap what did I get done`): the exchange lands in this same thread and
the reply comes back to you there under its name. Its schedule runs in
that same thread, so a run can be watched while it happens and asked about
afterwards, and what the agent remembers is the agent's own.

Dispatched into a project (by that project's orchestrator, or by KOS with a
project named), the agent gets an ordinary chat inside the project, under
the same brief, and is told that what it makes there goes in the project's
folder, so it lands with the project; its own folder stays for its notes.
It has one such chat per project: dispatched there again, the task goes to
the chat it already has, so its work in a project reads as one thread.

## On the dashboard

Agents, in the sidebar, lists them with what each is up to and opens each
one's page: its thread, the chats it has in projects, and beside the thread
its schedule (Run now, Pause), its file as fields (Edit), Open in Files and
Delete. `@agent:<name>` names one in a chat
or as a handoff target (`chats.handoff` takes it, as it takes `@chat:` and
`@project:`): the chat is told what the agent is for and where its thread
is. Coding sub-agents, the builds, are `@build:<id>` and live under Runs.

## How KOS makes one

The root, a project's orchestrator and the thread a surface talks to KOS
in (your Discord DM, iMessage or SMS) have four tools, and no other chat
does, so an agent cannot spawn more of itself:

- `agents.list`: what exists, with what each is for and when it runs.
- `agents.create`: the file, its thread, and its schedule if it has one.
  An existing name is refused unless `replace` is set.
- `agents.dispatch`: a task to an agent, handed over rather than waited on.
  When it answers, the chat that sent it gets the answer as a line of its
  own (after its turn, if it is mid-turn), and you are told.
- `agents.remove`: the file and the schedule go; the thread stays as an
  ordinary chat you can keep or delete. This one asks first.

KOS is told to tell a responsibility from a task: a question gets an answer,
an ongoing piece of your life gets a project, and something you want kept
up over time gets an agent. An agent keeps no tables or pages of its own;
work that needs them is dispatched into a project.

## What applies to it

Everything that applies to every other turn: the jail, the risk tiers and
approvals with their expiry, self-prompts per hour, the kill switch. A
purchase, a message to someone else, or anything else risky asks you, on
whichever surface you are on, however the agent was started.
