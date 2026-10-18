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

Standing agents work from here as from the dashboard: "keep an eye on
this listing" said in the DM makes one, "ask recap what I got done" sends
the task to it, and `@agent:<name>` names one. The DM thread is told when
a dispatched agent answers, and the answer is sent to you here as well. An
agent's own approvals, from its schedule or a dispatch, ask here like any
other; a message it sends you with `notify` arrives here too. Its thread
stays on the dashboard, under Agents.

To talk to an agent itself, start the message with its name: `@recap what
did I get done this week`, or `@agent:recap …`. That goes to the agent's
own thread, the same one its page shows, and its reply comes back here as
`Recap: …`; while it works, the story of its steps shows here as KOS's
would. A name that is not an agent's, or a name with nothing after it, is
an ordinary message to KOS.

```
KOS_SECRET_DISCORD=   bot token
KOS_OWNER_DISCORD=    your user id, and the inbound gate
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
(`@page:…`, `@schedule:[…]`) links to; without it the links point at the
host's own address, which works on the machine KOS runs on.

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
one fails. An approval is asked on every wired surface, and the first answer
wins; the other prompts settle to say how it went, and so does a prompt
whose ask lapsed because nobody answered in time.
