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
model class. Each is off until you switch it on under Memory, Jobs, and each
has a brief you can read and edit on the Schedule page.

- **Read** (`kos.memory`, every six hours, and whenever enough is unread):
  reads what was said since it last looked, keeps what matters with
  evidence. A claim citing events it was not shown is refused by the
  harness. A fixed extractor is the floor when the job is off and
  background extraction is on.
- **Tidy** (`kos.dream`, nightly): merges claims that are one thing,
  archives what has gone stale, flags contradictions and possible
  promotions for you to decide in the Inbox, writes the pages.
- **Condense** (`kos.observe`, hourly): writes observations for threads past
  their budget.

`kos eval memory`, `kos eval dream` and `kos eval observe` score each job on
a golden set, so a change to a brief is measured rather than felt.

## In a chat

Each turn is given the claims whose words match the message, the pinned
claims always, and the log moments that read like it. The chip beside the
composer shows exactly what came along. Pinning a claim puts it in every
conversation.

## Callers

Another program can share the memory within a grant: its own token, the
global tags it may read, whether it may write global. It never sees a
project or another caller. `kos memory-mcp --token ...` serves the grant as
an MCP server. `@kos/client` has a `CallerClient` for the same.
