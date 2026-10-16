# Channels

Every surface is an adapter over the same turn. What you can do in the
dashboard you can do from any of them, rendered down to what the surface
can show.

## Discord

Direct messages from one account. Buttons for approvals and for whatever
KOS offers; forms for answers that are not fixed. Slash commands are
answered by the host without a model turn.

```
KOS_SECRET_DISCORD=   bot token
KOS_OWNER_DISCORD=    your user id, and the inbound gate
```

## iMessage (macOS)

Your note-to-self thread, read from Messages' database and written through
Messages.app. The reader binds every query to that one thread in the SQL
itself. Needs Full Disk Access and Automation permission for Messages; under
launchd, the `node` binary itself needs Full Disk Access.

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
surface. An approval is asked on every wired surface, and the first answer
wins.
