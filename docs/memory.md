# Memory

KOS remembers in four layers, all in the workspace's SQLite file, all yours
to read and edit from the Memory page.

## The layers

**Log.** Every message in and out, kept forever, with who said it, in which
chat, under which project. Searched by words and by meaning at once (full
text plus vectors). A caller's words are kept at external trust: searchable,
never read as yours. Explicit forgetting hard-deletes, vectors included.

**Claims.** What KOS believes: a key, a value, a kind (fact, preference,
decision), tags, and where it applies: everywhere (global), one project, or
one caller. A claim is never overwritten; a change supersedes it and the old
row stays as history. Each claim links to the log events it was drawn from,
so you can see why KOS thinks it. Trust says who it came from: you, an
agent, a tool, outside.

**Observations.** A long thread gets a dated note standing in for its older
exchanges, so the context stays readable. The covered log events are
shadowed, not deleted.

**Pages.** Memory in prose, under `memory/`: one page for you, one per
project, written from current claims. Edit a line in the form
`- key: value` and it reads back as your word.

## The jobs

Memory is maintained by KOS itself, as three scheduled jobs on the cheap
model class, on either engine: on the Claude Agent SDK engine a cheap task
runs on the cheap route's model when the engine can run it, else on the
engine's smallest. Each is off until you switch it on under Memory, Jobs, and each
has a brief you can read and edit on the Schedule page.

- **Read** (`kos.memory`, every six hours, and whenever enough is unread):
  reads what was said since it last looked, keeps what matters with
  evidence. A claim citing events it was not shown is refused by the
  harness. A fixed extractor is the floor when the job is off and
  background extraction is on.
- **Tidy** (`kos.dream`, nightly): merges claims that are one thing,
  archives what has gone stale, writes the pages. A contradiction it
  cannot settle from the values, or a project claim that may be true
  everywhere, it flags with what it would do and how sure it is. Sure
  enough (Settings, Behaviour: 80% by default) and it does that itself,
  on the record as KOS's under Memory, Decisions; below that the question
  comes to the Inbox with the lean in front of you. A lean to leave things
  as they are is carried out without asking, since nothing changes. A
  claim is a line, not a report: `memory.remember` refuses more than 600
  characters and points the detail to a page or a file, and a long one in
  a decision is shown short with the rest a press away.
- **Condense** (`kos.observe`, hourly): writes observations for threads past
  their budget.

`kos eval memory`, `kos eval dream` and `kos eval observe` score each job on
a golden set, so a change to a brief is measured rather than felt. `kos eval
recall` scores what a turn is then given from a fixed store, with no model.

Every change a job, a chat or you made to a claim (changed, merged, archived)
is under Memory, Decisions, Changes, with what it said before.

## In a chat

Each turn is given what stands, the claims whose words match the message,
and the log moments that read like it. The chip beside the composer shows
exactly what came along.

- **What stands**: pinned claims and your own preferences in the scopes in
  play, up to eight, with half kept for your preferences however many pins
  there are. Pinning a claim puts it in every conversation of its scope: a
  global pin everywhere, a project's pin in that project.
- **What matches**: a word counts by how rare it is among the claims, so a
  word most claims share ("job", "project") does not bring them all along,
  and a message of only "can you do that again" matches nothing. Among the
  matches, a claim stated recently, by you, ranks first. One answer per key,
  the narrower scope's, within about 3000 characters.

Both engines log what you said and what KOS answered, so the Read job and
recall by meaning see every chat.

## Callers

Another program can share the memory within a grant: its own token, the
global tags it may read, whether it may write global. It never sees a
project or another caller. `kos memory-mcp`, with the caller's token in
`KOS_CALLER_TOKEN` (not `--token`, which `ps` shows), serves the grant as
an MCP server. `@kos/client` has a `CallerClient` for the same.
