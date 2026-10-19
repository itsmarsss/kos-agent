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
the dashboard's Inbox carry the same words. While a turn that takes
steps runs, one silent message tells its story, the words KOS says and
the steps it takes, redrawn as they happen, so the card for an approval
never lands first; when the answer comes, as its own message, the story
stays as the record of what was done. A turn with no steps gets no extra
message.

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
`#needs-you` (every approval, with its buttons, instead of your DM).
`Blobs` holds a channel per blob, its own thread; a blob answers there
under its own name, through a webhook, not as the bot. `Projects` holds a
channel per project, its orchestrator, so "add a tracker for this" said
there lands in that project; and under each project's channel, a thread
for every chat in the project, so the agents working in it read as the
threads they are. Each channel is bound to its conversation by the
`kos:…` line in its topic, so the binding is readable and a channel you
rename stays bound; a thread KOS made is bound by id, since threads have
no topic. A thread you start yourself under a project's channel is a new
chat in that project, titled as the thread; one under `#kos` is a chat at
the root; one under a blob's channel is the blob's thread. Channels
without a `kos:` topic are yours and KOS stays out of them, as it does
with anyone else's messages in its own.

A thread or channel is the chat it stands for, not only a door into it:
a turn taken on the dashboard, by a schedule or by a dispatch shows there
too, your words quoted with a note that they came from the dashboard and
the answer as KOS or as the blob under its own name. What you say on
Discord is already there and is not repeated.

The categories, channels and threads are made when the host starts and
kept in step every few minutes, so a new project, blob or chat appears
without a restart; a channel under the wrong category is moved; nothing
is ever deleted, and a thread archives itself when its chat goes quiet
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
(lay the server out now); the setting is kept, so a layout later keeps
what you chose.

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
