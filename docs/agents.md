# Agents

A standing agent is a responsibility KOS keeps for you. "Keep an eye on this
listing", "handle my travel", "every Saturday, plan the evening": each needs
somewhere to live between asks, and that is what an agent is. KOS makes one
from the sentence; nothing about it is code, and nothing is written for any
one job. The shopper, the researcher and the Saturday planner are the same
four tools with different briefs.

## What one is

A file, `agents/<name>.md`, that you can read and edit:

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

Each agent has a face: a blob whose colour, shape, gait and eyes come from
its name, so it looks the same in the rail, on its page, in a chat header
and in an `@agent:` chip, and no two look alike by accident. The face says
what it is doing: it glances about while working, bounces with a mark when
it needs you, droops on an error, and sleeps when its schedule is paused.
With reduced motion on, it holds still.

## Where it lives

Each agent has one standing thread, `agent:<name>`, on the agent's own page
under Agents, not in the Chats tab. Talk to it there as you would to any
chat. Its schedule runs in that same thread, so a run can be watched while
it happens and asked about afterwards, and what the agent remembers is the
agent's own.

Dispatched into a project (by that project's orchestrator, or by KOS with a
project named), the agent gets an ordinary chat inside the project, under
the same brief, so what it makes lands with the project.

## On the dashboard

Agents, in the sidebar, lists them with what each is up to and opens each
one's page: its thread, the chats it has in projects, and beside the thread
its schedule (Run now, Pause), its file as fields (Edit), Open in Files and
Delete. `@agent:<name>` names one in a chat
or as a handoff target (`chats.handoff` takes it, as it takes `@chat:` and
`@project:`): the chat is told what the agent is for and where its thread
is. Coding sub-agents, the builds, are `@build:<id>` and live under Runs.

## How KOS makes one

The root and a project's orchestrator have four tools, and no other chat
does, so an agent cannot spawn more of itself:

- `agents.list`: what exists, with what each is for and when it runs.
- `agents.create`: the file, its thread, and its schedule if it has one.
  An existing name is refused unless `replace` is set.
- `agents.dispatch`: a task to an agent, handed over rather than waited on;
  you are told when it answers.
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
