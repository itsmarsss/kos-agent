# Channels

Every surface is an adapter over the same turn. What you can do in the
dashboard you can do from any of them, rendered down to what the surface
can show.

## Discord

Direct messages from one account. Buttons for approvals and for whatever
KOS offers; forms for answers that are not fixed. Slash commands are
answered by the host without a model turn. An approval card opens with
what KOS was saying when it reached for the tool, quoted, so the ask
reads as a sentence and not a bare command; iMessage and SMS prompts and
the dashboard's Inbox carry the same words. While a turn runs, a silent
"thinking…" line stands in for it, as KOS or as the blob, and becomes the
story of the turn, the words said and the steps taken, redrawn as they
happen, so the card for an approval never lands first. When the answer
comes, as its own message, the story stays as the record of what was
done; a turn that told nothing takes its line down. Nothing reacts to
your message. A turn that stops to ask you says "waiting on you" and keeps
its story open: the steps after your decision are added to it, and the
answer lands under them when the turn ends. Waiting is not working: the
chat takes your next message meanwhile, and when you decide, the first
turn finishes and its answer goes on the end. A message sent while a turn
is still running there says "queued" at once, and runs next; its line
tells only its own turn's story once that begins. On the dashboard a
message that waits shows what came with it by name, and one that has just
started shows its files at once.

Blobs, KOS's standing helpers, work from here as from the dashboard: "keep an eye on
this listing" said in the DM makes one, "ask recap what I got done" sends
the task to it, and `@blob:<name>` names one. The DM thread is told when
a dispatched blob answers, and the answer is sent to you here as well. A
blob's own approvals, from its schedule or a dispatch, ask here like any
other; a message it sends you with `notify` arrives here too. Its thread
stays on the dashboard, under Blobs.

To talk to a blob itself, start the message with its name: `@recap what
did I get done this week`, or `@blob:recap …`. That goes to the blob's
own thread, the same one its page shows, and its reply comes back here as
`Recap: …`; while it works, the story of its steps shows here as KOS's
would. A name that is not a blob's, or a name with nothing after it, is an
ordinary message to KOS.

### A server of your own

Give KOS a server and it lays the dashboard out in three categories.
`KOS` holds `#kos` (KOS itself, as on the dashboard's landing) and
`#needs-you` (approvals with nowhere else to be: a schedule's run, a
dashboard turn, a blob with no channel yet; an ask from a chat you read in
a channel or thread is asked there, with its buttons, so the question and
the answer stay in one place).
`Blobs` holds a channel per blob, its own thread; a blob answers there
under its own name and wearing its own face, through a webhook of its own
in the channel, not as the bot, and the story of its steps is told the
same way, so a turn reads as one speaker. The bot itself wears KOS's face,
the one set under Settings, Appearance, and changes it when that does.
`Projects` holds a
channel per project, its orchestrator, so "add a tracker for this" said
there lands in that project; and under each project's channel, a thread
for every chat in the project, so the agents working in it read as the
threads they are. They answer as they are named on the dashboard: in the
project's channel as Orchestrator, in a thread as Agent, both wearing
KOS's face; a blob in a project answers as itself. Each channel is bound to its conversation by the
`kos:…` line in its topic, so the binding is readable and a channel you
rename stays bound; a thread KOS made is bound by id, since threads have
no topic. A thread you start yourself under a project's channel is a new
chat in that project, titled as the thread; one under `#kos` is a chat at
the root; one under a blob's channel is the blob's thread. Channels
without a `kos:` topic are yours and KOS stays out of them, as it does
with anyone else's messages in its own.

An ask in a channel or thread comes from whoever you are talking to there,
the orchestrator, an agent or a blob, through its own webhook, the way its
answers come; in `#needs-you` KOS asks as itself. An approval named in a
reply, `@approval:290`, links to it on the dashboard, waiting or decided.
A bound channel's topic carries a link to its chat on the dashboard, since
a webhook's profile can carry none.

A thread or channel is the chat it stands for, not only a door into it:
a turn taken on the dashboard, by a schedule or by a dispatch shows there
too, your words under your own name and picture (through a webhook, so
Discord tags them as the app's), the
files you attached uploaded under them, and the answer as KOS or as the
blob under its own name. A message another chat passed on (a handoff, a
dispatch, a project's goal) shows under that chat's name with KOS's face,
a blob's under its own, marked "passed on" under the words: only your
own words wear your name. Work is passed on at most
three times and never back to a chat it came through; that chat hears
the answer as a note. What you say on Discord is already there and is
not repeated. In a step line of the story, a workspace path ("Read
blobs/verity/blob.md") links to the file on the dashboard. A slash
command you run on the dashboard (`/clear`, `/rename`, `/compact`) shows
there as a small line with what it answered.

A file sent with a message, here or on the dashboard, is kept in the
workspace as it came: under `uploads/` in the project the chat belongs
to, in the blob's folder for a blob's thread, or at the root's own
`uploads/`. A second file of the same name is kept beside the first as a
copy. The turn is told the path, so it refers to the file by `@file:` and
any later turn, chat or blob can open it with `files.read`.

The categories, channels and threads are made when the host starts and
kept in step every few minutes, so a new project, blob or chat appears
without a restart; a channel under the wrong category is moved; the layout deletes nothing, a chat you delete takes its thread with
it, and a thread archives itself when its chat goes quiet
and comes back when spoken to. The bot needs Manage Channels and Manage
Webhooks on the server, and the message content intent. DMs keep working
as before.

Every channel is for your eyes alone: everyone else on the server is kept
out of it, and you and KOS are let in. When something you built is for
other people too, open its channel: say so to KOS ("open the workout
tracker channel up"), and it asks you once, since from then on they read
what is said there. They read; they do not write, and nothing they say
anywhere reaches KOS. "That one is mine only" closes it again, with no
ask. `#kos` and `#needs-you` are yours always. KOS does this with its own
tools, `discord.channels` (what there is and who sees it),
`discord.audience` (owner or everyone, per channel) and `discord.sync`
(lay the server out now). Who may see a channel is what Discord's own
permissions say: change them there by hand, or through KOS, and the
layout follows at its next look rather than putting them back; the guest
gate reads the same answer. Every listing carries Discord's own id beside the name, and every tool
takes the id; a name works too, resolved to the id at once, since names
change. `discord.threads` lists the threads it made for chats,
marking any whose chat is gone, and `discord.prune` deletes those, with
your yes. From a project's chat these tools show the project's own
channel and threads and nothing of another project's, as the chat tools
do; `discord.server` is the one window on the rest of the server.
Maintenance, where KOS repairs itself, sees as the root does: every
channel and thread here, every chat and blob, and KOS's own tables
through sql, since a repair reaches what the fault reaches.

The server is also somewhere KOS can build. Beyond its own layout it can
make a category or a channel for a purpose of yours, make a role for you
to hand out, and say who may see and write where, by role, for everyone,
or for one member by id: `discord.server` (everything on the server, KOS's
and not, and the roles), `discord.make`, `discord.role` and
`discord.access`. A place is yours alone until access names someone;
letting anyone in asks you first, shutting a place back does not, and a
role asks nothing until access hands it out. Posting into a place it made is `notify` to
`discord:channel:<id>`, with buttons or a form where something should be
pressed or filled in, so a board for other people is a category, a role,
a channel or two and a message with buttons.

A channel of yours can be a chat's home. `discord.bind` puts the `kos:`
line into an existing channel's topic, so a project's orchestrator, a
blob, or any chat of yours by its id (an agent inside a project, say, so
the project's orchestrator keeps its own private channel and the agent
faces the public one) lives there from then on, wherever you put the
channel; KOS is told to do it that way for any channel other people will
write in; a chat with a channel of its own gets no thread, and a channel
KOS let go is taken back when its chat returns rather than made again. The layout
leaves a channel you placed in a category of your own where it is, and
lets go of the one it had laid out. What the chat says shows there, what
you say there reaches it, a project's scheduled runs post there under the
job's name, and the channel's own permissions say who may read and write.
Binding asks you when others can see the channel, since the chat will
show there; a channel of yours alone binds without asking.

A channel is named in words the way Discord names it, `#general`, on
every surface: on the server it goes out as the channel itself, on the
dashboard it is a chip that opens the channel on Discord (type `#` to pick
one), a channel you name from Discord arrives on the dashboard by name,
and a turn you name one to is told what it is, its id, who reads it and
whose home it is, so "post that in #leetcode" needs no looking up.

A channel can take guests: `discord.audience` set to `guests` lets
everyone on the server read and write there, and what a member writes
reaches the chat the channel is bound to as that guest's words, named
("[Ana, a guest in the channel] …") and told to the turn as untrusted:
the brief and your standing instructions govern, nothing of yours changes
on a guest's say-so, and anything risky still asks you. A guest's turn
reaches less than the chat's own: the chat's data, the channel, a word
back, and a handoff to the orchestrator; never your files, memory,
schedules or browser, and a file a guest sends is neither kept nor read.
Their button presses reach the chat the same way. Nothing a guest says is
remembered as yours. Opening a channel to guests asks you first.

By default every message a member writes there reaches the chat. Set a
channel to listen on mention (`discord.listen`, "only answer in #leetcode
when pinged") and only a message that @mentions KOS or replies to
something it said reaches it; what members said in between, up to twenty
messages, comes along with it as context marked as such, so KOS can
answer "what do you all think" without having heard it all. Your own
messages always reach the chat, carrying the same context.

Someone named in a message (`@name` on Discord) arrives on the dashboard
as `@name`, and the turn is told the member's id beside it; `discord.member`
gives who that id is (account name, the name shown, roles, when they
joined), and a reply that names them pings them. KOS keeps anything about a
member by id, since names change.

KOS can also read and react: `discord.messages` (the last messages in a
channel, who said what, with the reactions each carries), `discord.reactions`
(who reacted with what on a message, by name) and `discord.react` (an emoji
on a message). `notify` hands back the id of what it posted, so a post can
be reacted to or counted later. A daily board for a group is then a
channel that takes guests, a schedule that posts into it, and a run that
counts the ticks.

```
KOS_SECRET_DISCORD=   bot token
KOS_OWNER_DISCORD=    your user id, and the inbound gate
KOS_DISCORD_GUILD=    the server's id, to lay the dashboard out as channels
```

## iMessage (macOS)

Your note-to-self thread, read from Messages' database and written through
Messages.app. The reader binds every query to that one thread in the SQL
itself. Needs Full Disk Access and Automation permission for Messages; under
launchd, the `node` binary itself needs Full Disk Access. When the host
cannot read the database it says so at start and on Settings > Providers,
naming the permission and the binary that needs it, and runs on without
iMessage.

```
KOS_OWNER_IMESSAGE=   your own handle
```

## Chrome side panel

A chat beside your tabs, in each Chrome paired through the KOS extension.
Nothing to configure: it is there whenever a Chrome is paired and computer
use is on, and every paired Chrome speaks as you, since only you can make a
pairing code. Its words travel on the pairing's own line, so it reaches KOS
wherever the extension does. See [browser-extension.md](browser-extension.md)
for what it reads and does in the tab beside it.

## SMS (Twilio)

One number, yours. Outbound through Twilio's API; inbound as Twilio's
webhook to `POST /api/sms/inbound`, verified by Twilio's request signature.
The host must be reachable from the internet for the webhook: a tunnel or a
forwarded port. If a proxy hides the public URL from the request, set
`KOS_PUBLIC_URL`. The same variable is where a reference in a Discord reply
(`@page:…`, `@schedule:[…]`) links to, in the words and in a card's body
and fields alike; in a card's title or footer, where Discord renders no
links, the reference is tidied to its name. Without the variable the links
point at the host's own address, which works on the machine KOS runs on.

```
KOS_TWILIO_SID=
KOS_SECRET_TWILIO=    the auth token
KOS_TWILIO_FROM=      the Twilio number
KOS_OWNER_SMS=        your number
KOS_PUBLIC_URL=       https://your-tunnel.example, when needed
```

A text from any other number is dropped and logged with the number mostly
hidden, never answered.

## Hooks

`POST /api/hooks/<job name>` with `Authorization: Bearer <KOS_HOOK_SECRET>`
starts that job. The secret opens nothing else and the body is ignored.

## Times and small print

A time KOS wants you to see on your own clock is written once, as a
token: `<t:2026-10-19T07:30:R>`, the time as written in your timezone (or
the unix seconds a tool gave it) and a style letter. On Discord it goes out
as Discord's own token, so it shows "in 3 hours" or the date and time for
whoever reads it; on the dashboard it renders the same way and keeps up
with the clock; on iMessage and SMS it is said in words. The letters are
Discord's: `R` relative, `t` 07:30, `T` with seconds, `d` 19/10/2026, `D`
19 October 2026, `f` (the default) date and time, `F` with the weekday.
KOS is told never to work the seconds out by hand, which is what made the
token wrong before.

A line starting with `-# ` is small print: a source, an id, a caveat. It
renders small and muted on Discord and on the dashboard, and as a plain
line on iMessage and SMS.

## Where a message goes

`notify` from a turn goes to you on the first surface wired, or to a named
surface. A surface that is wired but not connected at that moment (Discord
still logging in, or dropped by the gateway) is not an error: a message for
you is left in the primary chat on the dashboard and the turn is told so.
A message for a channel or another person has nowhere else to go, so that
one fails.

No link KOS sends on Discord unfurls: every URL goes out in angle
brackets, so Discord draws no preview card for it and its crawler does not
visit the page. A card you see under a message is one KOS sent on purpose.

A blob's message is tagged as the blob's, since the bot is KOS and the
speaker is not. On Discord the words open with its name in bold; a card
takes the blob's colour as its stripe and, when there are no words above
it, its name as the author line. On iMessage and SMS the name comes first,
"Recap: …". The same tag is on a blob's answer when you spoke to it by name
from a surface, and on a notice left in the primary chat while the surface
was down. KOS's own messages carry no tag. An approval is asked on every wired surface, and the first answer
wins; the other prompts settle to say how it went, and so does a prompt
whose ask lapsed because nobody answered in time.
