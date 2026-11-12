# Computer use

KOS can see and work a computer the owner has paired: the screen, the
pointer, the keyboard. The KOS core never leaves its jail to do it. A computer
is reached only through **KOS for Mac**, an app the owner installs on it, which
dials out to KOS, enforces its own rules, and shows the owner every moment it
is being driven.

Two packages, one protocol:

- `packages/computer` (`@kos/computer`): the KOS side. Pairing, the socket
  devices connect to, sessions, and the `computer.*` tools.
- `packages/device-macos`: KOS for Mac, a menu bar app.
- `packages/device-shared`: the Swift both apps share: the wire, the kit
  they are drawn from, and the line to KOS.
- `packages/browser-extension`: KOS for Chrome, a device that offers a
  Chrome's tabs instead of a screen (see [browser-extension.md](browser-extension.md)).
- `packages/device-ios`: KOS for iPhone, a device that only chats. It pairs
  and proves itself as the others do, but offers KOS no screen, no input and
  no browser (see [A phone](#a-phone)).

The computer KOS runs on and a laptop across the internet are the same case:
KOS for Mac on the host Mac dials `127.0.0.1`, on the laptop it dials the
server. The device always connects out, so nothing listens on it.

## Using it

1. Settings, Devices, Add a device. KOS shows a code and a link.
2. On the computer, open KOS for Mac and paste the link (or the address and
   code). The link opens it directly when the dashboard is on that computer.
3. Grant Screen Recording and Accessibility when it asks.

Then any chat can ask: "on my laptop, open the Figma file from yesterday".
`computer.devices` says what is paired and online, asking nobody.
`computer.start` picks the computer when one fits (or the one named; when
several could be meant, or the one there is is offline, it says what is
paired), the device asks you to allow the session, for how long, and the
session starts with its first picture. When you speak in the KOS for Mac
window no start is needed: the turn's first `computer.act` asks for the
session on that Mac, offering the app in front first and showing your words
(or the call's `intent`) as the task, and answers with the screen. Any other
turn in that chat (typed on the dashboard, a dispatch, a schedule, a resumed
approval) calls `computer.start`. After a no, an ask left unanswered (told to
the model as not answered, not as a no), or the owner's Stop, the turn does
not ask again. Stop while the device is asking withdraws the ask: KOS sends
`session.end` for it, the device takes the prompt down, and a yes given after
it, or after the turn ended, is given back at once.

**Stop.** The Stop in either device's chat (the send button while a turn, a
session or an ask is on the go, or Cmd+Enter), and the Stop on the bar, stop
the chat's turn as the dashboard's does, end its session on any device and
withdraw any ask for one; the rest of that turn asks for no session again.
The owner ending a session on the device while a turn runs is the same Stop.

**Ask and Auto.** The KOS for Mac window's mode chip is honoured: in Ask (the
default) each `computer.act` call that does more than look (a screenshot, a
zoom, a wait) goes to KOS's approvals once a session is live; in Auto it does
not. The first call of a turn only starts the session, which the Mac asks for
itself, so it is never asked twice.

A session your own turn started belongs to its chat and lasts until its
time, the device's idle limit, `computer.end`, you switching the chat window
to another chat (once a turn still running in the one you left has ended),
Stop, or the kill switch, so an approval decided later still finds it. A turn
keeps its own chat however the window is switched meanwhile: its steps and
pictures are told as that chat's, and its browser and screen calls stay on
that device. One that
other work started (a schedule, a dispatch, a guest) ends with its turn,
unless `keep` on `computer.start` holds it. A start KOS made unasked is in
the audit log as `computer.start` or `chrome.start`.

While KOS is in control:

- a glowing border runs round the screen it is using;
- its cursor glides to each point, marked as KOS's;
- `computer.act` takes one action or, as `actions`, a short run of them
  (click a field, type, press Return) with one picture at the end, so a
  sequence it can see through costs one round trip. The run is the same
  runner `browser.act` uses: Stop between actions and inside the one in
  flight, one wait budget of a minute a call for every wait in it (a pause,
  a wait for words on a page, the settle before the picture), none past the
  run's deadline, and "Done: ... Step 3 (click) failed: why." when it stops
  part way. Stop in a step a device cannot take back says no more than
  "step 3 may have finished on the device";
- the picture after an act goes only when the screen changed since the
  chat's last one, on any surface (one memory per chat, forgotten when a
  turn, a fresh query or a screen subagent starts); otherwise it is said in
  words, on the Mac and in a tab alike, and the step's picture is the last
  one kept;
- each step says what it is for in a few words (`intent`, "open the
  Quizzes tab"), which is the step's line wherever steps are listed; how
  it does it (click, type "BU354", press Return) is the line when there
  is no intent, and the step's detail on the dashboard when there is.
  Coordinates are never in the line;
- a bar at the top says what it is doing, with Take over and Stop, and its
  chat window says the same; Stop there stops the turn too;
- your own click or key pauses it at once, even right after you press Allow
  or Hand back (on the Mac, a deliberate move of the pointer too, past the
  3 seconds after Allow or Hand back); scrolling and small pointer moves do
  not, though after you scroll on the Mac KOS looks again before it acts.
  Only you hand
  it back, on the device or in its chat ("Paused, you have control", with
  Hand back and Stop). KOS waits up to five minutes for you: handed back, it
  looks again before acting; kept, it stops and tells you where it was. The
  device's idle limit does not run while you have it;
- its pointer and keys pass KOS for Mac's own windows by: they never land in
  the chat window or the bar;
- it does not type while a password field has focus;
- apps on the device's hidden list (password managers by default) are blanked
  from what it sees, and it cannot act on them.

## Reaching a server

A device must reach KOS over an encrypted path: `https` (a reverse proxy in
front of the host), a Tailscale address, or loopback. Plain `http` to any
other address is refused by the device. Tailscale is the simple answer for a
home server or a VPS: the laptop and the host join one tailnet and the device
uses the host's tailnet name.

A phone on the home Wi-Fi reaches KOS over the Wi-Fi listener instead: TLS
with KOS's own certificate, which the phone pins at pairing (see
[The Wi-Fi listener](#the-wi-fi-listener)).

## A phone

KOS for iPhone pairs as a device of its own kind, `phone`: `app.platform` is
`"ios"`, and its hello says `consent` `"device"`, `permissions` `{ "screen":
false, "input": false }` and no displays. A phone only chats. KOS never sends
it `session.begin` or any computer call; `computer.start` and `chrome.start`
never pick one, and refuse one named outright; the hub itself refuses a
session on a phone (`phone`), whatever asked for it. `computer.devices`
lists it as the owner's phone, chat only.

Its chat is the `phone` surface's, as the Mac window's is `mac`'s: the same
chat calls and events (`chat.show`, `chat.status`, `chat.ask`,
`chat.settled`, `chat.chats`, `chat.models`, `chat.mentions`; `chat.open`,
`chat.send`, `chat.attach`, `chat.stop`, `chat.decide`, `chat.list`,
`chat.switch`, `chat.models`, `chat.model`, `chat.mentions`), with `beside`
`{ "kind": "none" }` and no quote, and its own: the glance, the artifacts
and the dashboard's pages (below), the last the one call and event not
named `chat.`: `dashboard.reply` and `dashboard.request`. A phone's
`chat.auto` is ignored. The turn is told the words were said on the phone,
which KOS cannot see or work, and its reply is kept short and plain, since
the phone may read it aloud. A turn
begun there reaches the owner's computers and Chromes as one begun anywhere
does, each asking as it would; and the phone decides approvals, any chat's,
as the dashboard and Discord do. A phone answers a call it does not know
with `bad_request`.

**Glance.** A phone asks what is going on with the event `chat.glance`
(`{}`), and KOS answers by calling `chat.glance` on it:

```json
{
  "halted": false,
  "running": [{ "id": "c_1", "title": "Garden orchestrator" }],
  "waiting": 2,
  "asks": [{ "chat": { "id": "c_2", "title": "Inbox sweep" }, "approval": { "id": "41", "tool": "files.write", "args": "{\"path\":\"notes/list.md\"}", "why": "Saving the list.", "expiresAt": 1761800000000 } }],
  "failing": [{ "label": "Nightly backup", "streak": 3, "error": "disk full", "since": 1761800000000 }],
  "next": [{ "name": "kos.backup", "at": 1761800000000 }]
}
```

`running` is the chats with a turn on the go (ten at most), `waiting` the
count of every approval waiting on the owner, in any chat, `asks` the first
ten of them to lapse, soonest first, each as `chat.ask` carries its
`approval`, with the chat it is for (`chat`, absent for an approval no chat
asked for). The phone decides one with `chat.decide` by its id, as any
other. `failing` is the jobs failing now,
the longest broken first (ten at most), and `next` the five soonest runs of
enabled schedules. Times are epoch milliseconds. KOS sends it only when
asked; a device that does not know the call ignores it.

**Where a chat lives.** Each item of `chat.chats` may carry `place`: `{
"kind": "kos" }` at the root, `{ "kind": "project", "name": "Garden" }` in a
project, `{ "kind": "blob", "name": "scout" }` a blob's own. A device that
does not know it ignores it.

**Artifacts.** A phone reads the owner's artifacts, and only reads them. It
asks with the event `chat.artifacts` (`{}`), and KOS answers by calling
`chat.artifacts` on it with the thirty changed last of those the dashboard
opens (HTML artifacts out of the trash), each as the gallery says it:

```json
{ "artifacts": [{ "id": "plan", "title": "Garden plan", "kind": "doc", "description": "Beds, dates and costs.", "updatedAt": 1761800000000, "place": { "kind": "project", "name": "Garden" } }] }
```

It opens one with the event `chat.artifact` (`{ "id": "plan", "theme":
"dark" }`), and KOS calls `chat.artifact` with that item and `document`,
`themes` and `theme`, or with `{ "id", "error" }`:

- `document` is the frame the dashboard draws, built by KOS from the
  dashboard's own build: the wrapper document holding the page's in a
  sandboxed frame, with the policy that allows no network, the guard, the
  bridge, the tokens, the kit's CSS, the fonts and the kind's runtime, all
  inline, in the look of an older version (`data-locked`), which offers no
  editing. Pictures in an artifact are `data:` already (artifacts.md).
- `themes` is each theme's tokens as the rule the bridge takes on a change
  of theme: the device posts `{ "__kos": "theme", "mode", "rule" }` to the
  page's frame, as the dashboard does.
- The id must be an artifact's (`ARTIFACT_ID_RE`, at most 120 characters);
  one that is not, one the owner has not, one in the trash, an older widget
  page and an answer of more than 8 MB as JSON are each refused in words.
- One goes to a device at a time: one it asks for while another is on its
  way waits, and a later ask replaces it.

The page's `window.kos` reaches the device as it reaches the dashboard,
through the wrapper. A read it makes (`query`, `files.read`) goes as the
event `chat.read` (`{ "artifact", "call", "method": "query" | "file",
"args" }`), for the artifact the device last opened and no other, and KOS
answers by calling `chat.read` with `{ "artifact", "call", "result" }` or
`{ "artifact", "call", "error" }`, decided as the dashboard's reads are.
Nothing else is relayed: a write, a save, an ask, a mention and a present
are refused by the device itself. `open`, another artifact by its id, is
the device's to do from a doc alone, only just after the owner pressed in
the frame, as the dashboard holds it. The device opens nothing outside
itself: there are no links off an artifact to open. What a device had open
is forgotten when it leaves its line. Every other device kind's asks go
unanswered.

**The dashboard's pages.** A phone's pages (Inbox, Projects, Artifacts,
Blobs, Files, Memory, Runs, Overview) ask the dashboard's own routes, and
the dashboard's own handler answers, as the owner, with no token (the
phone is proved on its line) and no Origin. The phone asks with the event
`dashboard.request` (`{ "call": 1, "method": "GET" | "POST", "path":
"/api/...", "query"?: { "<key>": "<string>" }, "body"?: { ... } }`), and
KOS answers by calling `dashboard.reply` with one of:

- `{ "call", "status", "body" }`: the route's JSON, its own 4xx errors too;
- `{ "call", "status", "type", "data" }`: the route answered bytes, `type`
  their content type and `data` their base64 (a picture, a PDF, an export);
- `{ "call", "error" }`: refused in words before the route was asked, or
  the route failed.

The reads, each with the query keys it takes and no other:

- `/api/home`, `/api/inbox`, `/api/approvals`, `/api/approvals/history`
  (`before`, `status`, `q`, `limit`), `/api/approvals/history/counts`,
  `/api/approvals/<digits>`;
- `/api/projects`, `/api/projects/<slug>/detail`;
- `/api/artifacts` (`trashed`), `/api/artifacts/<id>/export` (`format`,
  `tab`, `theme`; bytes, which the phone shares);
- `/api/agents`, `/api/conversations/<id>/messages` (which marks the chat
  read, as opening it on the dashboard does);
- `/api/files`, `/api/file`, `/api/file/text`, `/api/file/raw` (a picture's
  bytes), `/api/file/view` (a PDF's bytes), each `path`;
- `/api/memory` (`limit`), `/api/memory/trace` (`key`);
- `/api/runs` (`limit`, `failed`), `/api/crons`.

And the actions, `POST`, each with exactly its body: `/api/approve` (`{
"id": 41, "remember"?: true }`), `/api/deny` (`{ "id": 41 }`),
`/api/crons/run` (`{ "id": 3 }`), `/api/crons/enable` (`{ "id": 3,
"enabled": false }`, pause and resume) and `/api/artifacts/<id>/restore`
(`{}`, out of the trash). An approval is not decided through the handler:
it is decided as `chat.decide` decides one, the phone as its decider, so it
settles everywhere as a phone's decision does, and answers `{ "id",
"approved", "outcome"? }`. Every action is written to the audit log as
`device.dashboard`, with the device, the method, the path and the body.
Nothing else is asked, read or write.

- The path is matched whole. A segment is never `.` or `..`, empty, or
  longer than 160 characters; the path holds no `%`, `\`, `?`, `#` or NUL
  and is at most 512 characters. `<digits>` is digits, `<slug>` a
  project's slug, `<id>` an artifact's (`ARTIFACT_ID_RE`) or a chat's as
  KOS makes them (`c…:owner`, `project:garden`, `agent:scout`, `cron:1`).
- A query value is a string of at most 1024 characters. A file's `path`
  that is absolute or steps up (`..`) is refused before the route is
  asked; the route's own jail is the fence.
- An answer of more than 8 MB as JSON, the base64 in it, is refused in
  words. Four asks are on the way from a phone at once; a fifth is refused
  in words.
- Phones only: every other device kind's asks go unanswered.

**Files with the words.** A device's frames over the Wi-Fi are at most
512 KB, so each file the owner sends with their words comes first, in
parts, as `chat.attach` events, and `chat.send` names them by the ids the
device gave them (`"files": ["f1"]`); `text` may then be empty:

```json
{ "id": "f1", "name": "receipt.jpg", "mediaType": "image/jpeg", "part": 0, "parts": 3, "data": "<base64, at most 262144 characters>" }
```

Every part but the last is a whole number of base64 quads, unpadded. A
file's part 0 sent again starts that file over. A file is at most 5 MB as
the model's path measures it (from its base64's length), and is what its
bytes say: a JPEG, PNG, GIF or WebP picture (SVG, HEIC and TIFF are refused),
a PDF, an Office file, or text with no NUL in it. Four go with one message,
and four are held for a device at once, each for five minutes and never past
the device's line. A file named by `chat.send` that did not arrive whole, or
was refused on the way in, stops the words: KOS answers with `chat.status`
carrying `error` and the words as `said`, and nothing is sent to the turn.
A device downscales a photo before it sends it (KOS for iPhone: 2048 px on
the long side, as JPEG), and sends a file given back after a dropped line
under a new id.

## The Wi-Fi listener

The dashboard, its API and the device socket listen on loopback. For a
phone on the home Wi-Fi, KOS can open one more listener, for pairing and the
device socket alone.

- **Off by default.** Settings, Devices, Phones on this Wi-Fi turns it on and
  off at once (`POST /api/devices/settings { "lan": true }`; the setting is
  `lan`). `KOS_DEVICE_LAN=1` turns it on whatever the setting says.
  `GET /api/devices` says where it stands: `lan { on, forced, port, urls,
  pin, words, error? }`. Anyone on the same network can reach its pairing
  page while it is on, so the dashboard says to leave it off on a shared one.
- **Where.** Port `KOS_DEVICE_LAN_PORT`, else the dashboard's plus two
  (4319 beside 4317), on every interface unless `KOS_DEVICE_LAN_HOST` names
  one. `urls` are `https://` and each home network address of the host.
- **Private addresses only.** A connection from outside 10/8, 172.16/12,
  192.168/16, 169.254/16, 127/8, `::1`, fc00::/7 and fe80::/10 (and their
  IPv4-mapped forms) is dropped before TLS.
- **TLS only, pinned.** KOS makes its own ECDSA P-256 key and a self-signed
  certificate once, kept outside the workspace with the device host key
  (`~/.kos/device-lan.pem`, mode 0600; `KOS_DEVICE_LAN_CERT_FILE` moves it,
  to a folder others cannot write to).
  A phone never trusts it; it pins it. The pin is the SHA-256 of the
  certificate's DER, base64url without padding. Its words are the hash's
  first 16 hex digits in four groups (`4F2A 91C3 77D0 1B5E`), for the owner
  to compare by eye.
- **What it serves.** `GET /api/devices/lan` answers `{ "kos": true,
  "protocol": 1 }`, so a phone can see the certificate before it sends a
  code. `POST /api/devices/pair` pairs as on loopback, for platform `"ios"`
  only (403 otherwise), its JSON body at most 4 KB (413, said before the
  body is read when its length says so). The upgrade at
  `/api/devices/socket` is the device socket, which here takes phones alone,
  in frames of at most 512 KB: any other device is closed with `4003`, a
  proved one with `not a phone: only phones connect over Wi-Fi`. Every other
  path is a 404, the dashboard and the rest of the API among them.
- **Limits.** Five pairing attempts a minute from one address and thirty
  from all, twenty socket upgrades a minute from one address and sixty from
  all (429 with `Retry-After`, and the connection closed); a wrong code still
  counts toward voiding every open code. An IPv6 address counts as its /64.
  At most eight connections from one address and 64 in all, and two device
  sockets from one address and sixteen in all (429). A connection whose TLS
  handshake, or whose request with its body, takes more than ten seconds is
  dropped.

While it is on, a code made on the dashboard also carries `lan { url, urls,
pin, words }`, and the dashboard offers the phone link
`kos-device://pair?url=<url>&code=<code>&pin=<pin>`. A phone given an
address and a code instead asks `GET /api/devices/lan` for the certificate
it is served. Either way it shows the address and the certificate's words
(the link's pin, or the one served) and sends the code, pinned to that
certificate, only once the owner says they match what the dashboard shows;
a link for a KOS with no pin is agreed to by its address. Anything on the
phone can open a link, so none pairs by itself, and one opened while the
phone is paired first asks to replace that pairing (the KOS it replaces is
told to forget the phone). Every connection then proves both keys, as any
device's does.

## Security model

- **Pairing** is a one-time code made on the dashboard, good for ten minutes
  and one use. The device sends its public key with the code; KOS answers with
  its own. Each side keeps the other's key. A device may be paired with more
  than one KOS: each pairing has its own keys, line and consent, and each KOS
  sees the device as one of its own.
- **Every connection** proves both keys: KOS signs the device's nonce, the
  device signs KOS's. A host that cannot sign is not KOS, whatever its address.
- **Consent lives on the device.** By default every session is allowed by the
  owner on the device itself. The owner may switch that off on the device for
  unattended use; KOS then asks through its approval queue instead. Nothing
  KOS sends can change the device's settings.
- **A session is bounded**: one at a time across every KOS the device is
  paired with (another that asks is answered `busy`), ended at its time limit,
  when idle, on Stop, when the app quits, and when the connection to the KOS
  that owns it drops. Only that KOS can act in it or end it. KOS's
  kill switch ends every session. The device sets the longest session and the
  idle limit; KOS only says how long it asks for.
- **Work the owner did not start stays off.** A schedule, a blob's own timer
  or a guest in a channel cannot start a session unless the owner allows it
  in Settings, Devices, and then the device still asks.
- Keys: the device's lives in its Keychain; KOS's lives outside the workspace
  (`~/.kos/device-host.key`, `KOS_DEVICE_KEY_FILE` to move it, or
  `KOS_DEVICE_HOST_KEY` as base64 PKCS#8 for a container), so the agent never
  reads it. It is not a `KOS_SECRET_` name: those the agent can place in a
  request.

## Protocol

Version 1. JSON over a WebSocket at `/api/devices/socket`, text frames, one
message per frame, at most 16 MB. Every message has a type `t`.

### Pairing (HTTP)

`POST /api/devices/pairings` (owner, dashboard token) makes a code:

```json
{ "code": "K7QX-M2PA", "expiresAt": 1761800000000 }
```

`POST /api/devices/pair` (no token; the code is the proof):

```json
{ "code": "K7QX-M2PA", "name": "Studio MacBook", "platform": "macos", "publicKey": "<base64, 32 bytes Ed25519>" }
```

answers `{ "device": "dev_...", "hostKey": "<base64, 32 bytes>", "protocol": 1 }`.
A wrong code is a 403. After ten wrong codes in ten minutes every open code
is void.

The pairing link is `kos-device://pair?url=<KOS address>&code=<code>`, and a
link for a phone over Wi-Fi adds `&pin=<pin>`, the certificate the phone pins
(see [The Wi-Fi listener](#the-wi-fi-listener)).

### Handshake

1. KOS: `{ "t": "challenge", "protocol": 1, "nonce": "<base64, 32 bytes>" }`
2. Device, within 10 s:

```json
{
  "t": "hello",
  "protocol": 1,
  "device": "dev_...",
  "nonce": "<base64, 32 bytes>",
  "signature": "<Ed25519 over 'kos-device/1|device|<KOS nonce>|<device id>'>",
  "app": { "version": "0.1.0", "platform": "macos", "os": "26.4.1" },
  "consent": "device",
  "permissions": { "screen": true, "input": true },
  "displays": [{ "id": 1, "width": 1512, "height": 982, "scale": 2, "main": true }]
}
```

3. KOS: `{ "t": "welcome", "name": "<device name>", "signature": "<Ed25519 over 'kos-device/1|host|<device nonce>|<device id>'>" }`

Nonces are signed as their base64 text. Either side closes on a bad
signature. Close codes: `4001` malformed, `4003` unknown device, bad
signature or (on the Wi-Fi listener) not a phone, `4009` replaced by a newer connection of the same device, `4010`
protocol version not spoken.

After the welcome the device sends `{ "t": "state", ... }` with `consent`,
`permissions` and `displays` whenever one changes.

Right after the welcome, and again whenever the owner changes it, KOS sends
its face, decided, so the device draws KOS as the dashboard does without
repeating the hash:

```json
{
  "t": "face",
  "face": {
    "fill": "#3585ed",
    "ink": "#141d29",
    "eyes": "half",
    "gait": 1,
    "shape": { "aspect": 1.05, "squat": 0, "spread": 0.93, "lobes": [{ "k": 2, "amp": 0.06, "phase": 1.2 }] }
  }
}
```

`eyes` is `round`, `half` or `sparkle`; `gait` 0 to 3 (steady, lively, slow,
restless); `lobes` the outline's lumps, each `k` bulges `amp` of the radius
out, turned `phase` radians (`outline` in `@kos/shared` `blob.ts`). A device
keeps the last face of each KOS it pairs with, draws that KOS by it, and
draws the default face for a KOS that has sent none. A device that does not
know the frame ignores it.

After the face, and again whenever either changes, KOS sends the dashboard's
theme, KOS's own setting (`appearance.theme`, light, dark or system, "system"
until the owner chooses), and `drawn`, the palette a dashboard last reported
drawing it in (`appearance.drawn`, light or dark), once one has:

```json
{ "t": "theme", "mode": "system", "drawn": "dark" }
```

`drawn` is how the dashboard looks, "system" read in the dashboard's own
browser, which need not agree with the device's: a Chrome forced dark draws
System dark on a Mac in light. The dashboard reports it
(`POST /api/settings/theme/drawn`, [dashboard.md](dashboard.md)); with several
dashboards open, the latest report wins. Choosing light or dark sets `drawn`
to the same at once, since either is drawn as itself. A report never
expires: KOS keeps the last palette a dashboard reported until one reports
another, so every device keeps the dashboard's last look with no dashboard
open. Only a workspace no dashboard has reported in yet sends the theme
without `drawn`.

A device keeps its own choice of theme locally: "dashboard", the default,
draws as the dashboard looks, `drawn` when it was sent, else `mode` ("system"
then being the device's own appearance), and the device's appearance before
any frame arrives; "light", "dark" or "system" ignore the frame. Paired with
several KOS, a device keeps each one's theme and draws that of the KOS whose
session is at work, else the first connected, else the first paired. Nothing
KOS sends changes that choice. A device that does not know the frame ignores
it, and one that does not know `drawn` draws `mode`.

When the owner unpairs the device on the device, it sends `{ "t": "unpair" }`
before it hangs up. KOS forgets it, as Remove on the dashboard does: any
session ends and the line closes with `4003`. A device can only unpair itself,
on a line it has proved.

### Calls

KOS: `{ "t": "call", "id": 7, "method": "pointer.click", "params": { ... } }`

Device: `{ "t": "reply", "id": 7, "ok": true, "result": { ... } }` or
`{ "t": "reply", "id": 7, "ok": false, "error": { "code": "paused", "message": "..." } }`

Every method but `session.begin` takes `session`, and the device refuses it
without that session live. A Chrome takes the side panel's chat calls, and a
Mac running KOS for Mac takes the same ones for its chat window; neither
needs a session ([browser-extension.md](browser-extension.md), and below).

| Method | Params | Result |
| --- | --- | --- |
| `session.begin` | `session`, `task`, `requester`, `conversation?`, `target? {app}`, `minutes`, `maxEdge?` | `granted`, `until`, `space {width,height}`, `target {kind, app?, title?}` |
| `session.end` | `session` | `{}` |
| `screen.capture` | `session`, `region? {x,y,width,height}`, `settle?` (ms, at most 1000: after an action, look until two pictures 50 ms apart agree, once the screen has changed or 120 ms have passed, or the time is up) | `image` (base64), `mediaType`, `width`, `height`, `cursor {x,y}`, `app?`, `settled?` (true when it waited as asked; KOS then stops waiting on its side) |
| `pointer.move` | `session`, `x`, `y` | `cursor` |
| `pointer.click` | `session`, `x`, `y`, `button?` (left, right, middle), `count?` (1 to 3), `modifiers?` | `cursor` |
| `pointer.drag` | `session`, `from {x,y}`, `to {x,y}` | `cursor` |
| `pointer.scroll` | `session`, `x`, `y`, `dx`, `dy` (lines; positive is down and right) | `cursor` |
| `keys.type` | `session`, `text` (at most 4000 characters) | `cursor` |
| `keys.press` | `session`, `keys` (one combination, `cmd+shift+t`), `repeat?` | `cursor` |

**What is shared.** The owner picks, as a screen-sharing picker offers it: the
entire screen, or one window. `target.app` is the app KOS would work in; its
window is offered first. With a window, `space` is that window, a capture is
that window alone (whatever covers it), every call lands in it after it is
brought to the front, and the session ends (`window`) if it closes. The
answer's `target` says which was shared.

`session.begin` is answered when the owner decides, or when the prompt's wait (60 s unless the owner set it) runs out. Not granted, it is `{ granted: false, reason? }`: no reason is the owner's no, `unanswered` the wait running out, `withdrawn` KOS taking the ask back. KOS takes an ask back by sending `session.end` with the ask's session id while the device is asking; the device takes its prompt down and answers `withdrawn`.
`minutes` is what KOS asks for; the owner may choose less. `requester` is the
asking chat's title and `conversation` its id, so the device can link the
owner to it on the dashboard (`<KOS address>/#/chats/<id>`).

**Coordinates** are in the session's `space`: the screen in points, scaled
down to fit `maxEdge` (default 1280) on its long side. A capture without a
`region` is exactly `space` in pixels, so a point in the picture is a point to
click. A capture with a `region` is that part at up to `maxEdge`, for reading
detail; calls still take `space` coordinates.

`app` names the app in front: `{ "name": "Safari", "bundle": "com.apple.Safari" }`.

Key names: letters, digits, `return`, `tab`, `space`, `escape`, `backspace`,
`delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`,
`f1` to `f20`, and punctuation by itself (`-`, `=`, `[`, `/`, ...). Modifiers:
`cmd`, `shift`, `ctrl`, `alt` (`option`), `fn`. xdotool spellings
(`Return`, `super+c`, `Page_Down`) are read too.

### The chat window

KOS for Mac floats a chat window over the owner's apps (⌥⌘K, or Chat with KOS
in its menu): the side panel's chat, on the Mac. It takes the side panel's
calls but `page.read` (`chat.show`, `chat.status`, `chat.ask`,
`chat.settled`, `chat.chats`, `chat.models`, `chat.mentions`) and sends its
events (`chat.open`, `chat.send`, `chat.stop`, `chat.decide`, `chat.list`,
`chat.switch`, `chat.models`, `chat.model`, `chat.mentions` and `chat.auto`),
as [browser-extension.md](browser-extension.md) lists them: every status says
which chat it is about (`chat`), what that chat waits on (`waiting`) and
whether the owner holds its session (`held`), and a device draws none for a
chat it does not show. Hiding the window leaves a
session its chat holds running, so KOS can work the screen. Its chats are the `mac`
surface's, as the panel's are `chrome`'s, and a Chrome's words never reach
it nor the other way round.

`chat.send`'s `beside` is where the owner was: `{ "kind": "app", "name",
"bundle"?, "title"? }`, the app in front of the window and its front
window's title; `{ "kind": "hidden" }`, an app the owner hid from KOS,
named no further; or `{ "kind": "none" }`. The turn is told that app is
what "this" means, and that its first `computer.act` asks to see it or work
in it, on that Mac, offering that app's window first. The window never takes the front from that
app, so it stays what the owner was looking at. Said while a turn runs, the
words and where they were said are taken into that turn at its next step, as
on the dashboard. `quote? { text, from }` is what the owner quoted with
their words; it is kept with the message and shown with it, and never read
as their words.

The quote is what the owner selected in that app, read through Accessibility
once each time the window opens (again only if the app or its focused element
changed), off the main thread and within about 150 ms. Never from a password
field, while secure input is on, or from a hidden app. Electron and Chromium
apps keep their Accessibility tree off until asked, so when the first look
finds nothing in one, KOS for Mac briefly turns its tree on
(`AXManualAccessibility`, or `AXEnhancedUserInterface` in a Chromium browser
that does not take it), gives it 200 ms to build, reads again and turns it
off. While it is on the app sees an assistive technology. Code editors on
Electron watch for that and may switch to a screen reader mode, or say one
was detected, each time it is turned on, so in VS Code, VS Code Insiders,
VSCodium, Cursor and Windsurf it is never turned on: their selection comes
in only when their tree is already on (a screen reader, or the owner's own
setting), and otherwise nothing comes in, with no hint.

### Events

Device: `{ "t": "event", "name": "session.paused", "data": { "session": "...", "reason": "owner" } }`

| Event | Data |
| --- | --- |
| `session.paused` | `session`, `reason` (`owner`: they clicked or typed) |
| `session.resumed` | `session` |
| `session.scrolled` | `session` (the owner scrolled without taking over; sent once until KOS takes a whole-screen picture, and until then KOS acts on nothing but a look) |
| `session.extended` | `session`, `until` (the owner gave it more time on the device) |
| `session.ended` | `session`, `reason` (`owner`, `expired`, `idle`, `quit`, `host`, `window`) |

### Errors

`no_session`, `paused`, `busy` (another session is live, or this chat is already asking), `denied`,
`permission` (Screen Recording or Accessibility not granted), `secure_input`
(a password field has focus), `hidden_app` (the target is on the hidden list),
`bad_request`, `internal`.
