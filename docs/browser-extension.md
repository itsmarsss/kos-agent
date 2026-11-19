# KOS in your Chrome

KOS has a Chrome of its own (see [browser.md](browser.md)). **KOS for
Chrome**, an extension, lets it work in yours: the one you are signed in to everything
with, on your laptop, while you watch. It is a device, paired and proved the
way KOS for Mac is (see [computer.md](computer.md)), that offers tabs instead
of a screen.

`packages/browser-extension` is the extension. The KOS side is the device
hub of `@kos/computer`, which drives the extension's tabs with the same
hands `@kos/browser` drives its own Chrome with.

## Using it

1. Build it: `pnpm -C packages/browser-extension build` from the repo
   (`pnpm build` does too).
2. Load it: chrome://extensions, turn on Developer mode, Load unpacked, and
   pick `packages/browser-extension/dist`. Pin the KOS icon from the puzzle
   piece menu.
3. In KOS: Settings, Devices, Add a device, Copy link. Click the KOS icon,
   paste the link, press Pair. It shows Connected.
4. Ask from any chat: "in my Chrome, ...". KOS calls `chrome.start`, the
   extension asks you in a window of its own, and while the session lasts
   that chat's browser tools work in your Chrome. A session your own turn
   started belongs to the chat and lasts until its time, the idle limit,
   `chrome.end`, you switching the panel to another chat (once a turn still
   running in the one you left has ended), Stop, disconnect, or the kill
   switch; one other work started (a schedule, a dispatch) ends with its turn
   unless `keep`.

To give KOS a tab you are on, click the KOS icon there and press Give this
tab to KOS. The extension needs no access to your sites to work in a tab: it
asks Chrome for the debugger, tabs, tab groups, the side panel and its own
storage. Reading a page for the side panel's chat is the one thing that
needs more, and it is asked for there, once, when you allow it.

**Updates.** Loaded unpacked from this KOS's `packages/browser-extension/dist`,
the extension keeps to KOS's build by itself: after a deploy rebuilds the
folder, KOS tells it, and it reloads into the new build once no side panel
is open, no side panel turn runs and no session is held or asked for, once
per build: a reload takes an open panel down under the owner. Settings,
Devices shows its build and where it stands, with Update now. The rules are
in [computer.md](computer.md#builds-and-updates).

### The side panel

The panel button in the popup opens a chat with KOS beside your tabs, as
Claude in Chrome does. It is one more surface, `chrome`, carried on the
pairing's own line: one stream like iMessage's, shown on the dashboard as
Chrome, with `/new` behind the pen. The chat is the one KOS keeps, so a turn
taken on the dashboard (or in another of your Chromes) shows in the panel as
it goes, as it does in its Discord thread: your words when it starts, its
steps as they happen, the answer when it lands. Each turn's steps fold to a
line you can open, and an approval the chat asks for is decided in place.

- **Reading the page.** Each message says which tab it was said beside,
  so "this page" is that tab and not one of KOS's own pages, and KOS reads
  it with `chrome.page` when your words are about it: its address, title,
  what you selected, its headings and the first 4,000 characters of its
  text, then 12,000 a read on asking (`from`). Only the panel's chat can, only while the panel is
  open on that chat, and never on a hidden site. The first time, the panel
  asks you to let KOS read pages (Chrome's grant, one press); Not now, or no
  answer in your wait, is a no that KOS hears and says.
- **Working in the tab.** When you speak in the panel, the turn's first
  browser call asks in the panel, not in a window, showing your words as
  the task, and the session works in the tab beside it, where you are
  looking; no `chrome.start` call is needed. Any other turn in that chat
  (one typed on the dashboard, a dispatch, a schedule, a resumed approval)
  calls `chrome.start`. The ask shows how long it waits, and offers to let
  the session act on the tab's site without asking each step, so the first
  step is not a second prompt (running script in a page and the other strict
  tools still ask). After a no, an ask left unanswered (told to KOS as not
  answered), or Stop, the turn does not ask again. It never falls back to
  KOS's own browser: a session that cannot start refuses the call, and the
  chat says why. A Chrome set to leave sessions to KOS's approvals is the
  one exception, started by `chrome.start` so those approvals gate it.
  Speak from another tab while it lasts and KOS works there instead. The
  session lasts for the chat, as above. The border, the bar, Take
  over and Stop are the same as any session's, and Take over, Hand back and
  Stop are in the panel too, whichever tab is beside it.
- **Stop.** While the chat has a turn running, a session at work or an ask
  up, the send button is Stop (Cmd+Enter too): it stops the turn as the
  dashboard's does, ends the chat's session and takes down any ask. The
  bar's and the popup's Stop do the same for the session's chat. Words
  typed while a turn runs are taken into it at its next step, with the tab
  they were said beside, as on the dashboard.
- **The foot.** Under the chat, the turn's dots, what it is at and its
  clock; "Waiting on you", with neither, while KOS asks you to allow a
  session or decide an approval; "Paused, you have control", with Hand
  back and Stop, while you hold the chat's session. KOS says each as it
  changes. An approval reads as the dashboard's (Approve, Always, Deny),
  with why KOS asks and how long until it lapses.
- **Switching chats.** The chat's name under KOS opens the panel's own
  chats, newest first, with New chat on top. The panel is a place of its
  own: its chats are the ones made in it, and /chats and /switch there move
  among those alone. A turn still running in the chat you left goes on as
  that chat's: its steps and pictures are not drawn in the one you moved
  to, and it keeps working in your Chrome until it ends.
- **What you select.** Text you highlight on the page beside the panel
  shows above the box and goes with your next message as a quote from that
  page; × leaves it out. The quote is kept with your message and shown with
  it here and on the dashboard, but it is not your words. It is read only on
  pages KOS may read, never on a hidden site, only by a panel open in that
  window, fresh each time a panel opens, and forgotten when the window's
  last panel closes.
- **/ and @.** Typing / lists the commands, @ the things KOS can name
  (projects, pages, files, chats, schedules), from the index the dashboard's
  @ menu asks; what you name shows as a chip in your message.
- **The model.** The chip under the box is the dashboard's picker: the
  model KOS answers with, everywhere. On the Claude Agent SDK it names the
  engine instead, which chooses its own.
- **Math.** A formula KOS writes in LaTeX (`$...$` in a line, `$$...$$` on
  its own) is typeset, as on the dashboard.
- **Found again.** Chrome stops the extension's worker when it likes; the
  panel finds the new one in a moment and keeps what you pressed meanwhile
  (Stop, an approval, your words), sent in order once it is back; words
  given back to the box are not sent. The worker keeps a Stop or a decision
  until its line to KOS is back, across its own restarts. A Stop lapses
  after a minute, one that names no chat is not kept, and each says how
  long ago it was pressed, so KOS lets go of one pressed before the turn
  running by then began. A turn
  that ran while the panel was away shows as running, with its steps so far
  and its clock from when it began. When the chat's session in this Chrome
  ends, the panel says why.
- **Nothing waits forever.** KOS says it took your words at once; if it does
  not within a few seconds, the panel says so and puts them back in the box.
  A KOS that is connected but never shows the chat is one from before the
  side panel, and the panel says to update it.

The popup is laid out as the KOS for Mac window is, with KOS's face moving as
it does on the dashboard (the same code, `@kos/shared/blobmotion`):

- **Several KOS.** Add a KOS pairs another, say one at work beside one at
  home. Each folds to a line and opens to its own Ask before each session,
  Connect or Disconnect, its dashboard and Unpair; pairing one already here
  again replaces it. Chrome has one owner at the keyboard, so one session
  runs at a time: another KOS that asks meanwhile hears `busy`, and only the
  KOS whose session it is can act in it, hears its events, or ends it by
  going away.
- **Hidden from KOS.** Sites KOS never opens, never acts on and never hears
  of, each with its subdomains; password managers' web vaults are there from
  the start. A tab on one is listed only as hidden, and its events are not
  passed on.
- **Settings**, behind the gear: the longest session, how long the ask waits,
  the idle limit, whether scrolling a KOS tab pauses KOS, the theme, whether
  each KOS connects when Chrome opens, the time left on the KOS icon,
  whether KOS's full bar shows on the page, and Copy log. The log
  is kept for the browser session, and its newest lines (about 40,000
  characters) in local storage too, so a reload of the extension or of
  Chrome keeps them.
- **The theme.** Same as dashboard (the default), Light, Dark or System,
  kept in this Chrome (`chrome.storage.local`). Same as dashboard draws as
  the dashboard looks: the palette a KOS sent (`drawn` in `{ "t": "theme" }`,
  [computer.md](computer.md)), else its mode, kept with each pairing: that of the KOS whose session is at work, else the
  first connected, else the first paired, as the toolbar icon picks its
  face; and this computer's appearance before that KOS has sent one; System is this computer's appearance (`prefers-color-scheme`),
  whatever the dashboard says. The popup, the side panel and the consent
  window wear it before their first paint (`theme.js`, a classic script in
  each page's head, from the pages' own copy of the last answer) and change
  at once, all of them, when the setting or the dashboard does. The bar on
  a page wears it too, System there being the page's own appearance; it is
  opaque, edged in its tone and shadowed in either palette, so it reads on
  a light site and a dark one alike.

While KOS works in your Chrome:

- it works in a window of its own, its tabs grouped as **KOS**, and in any
  tab you gave it; no other tab is reachable;
- each of those tabs has a glowing border and a small bar saying what KOS
  is doing, with **Take over** and **Stop**; drag the bar anywhere, or
  press KOS's face on it to fold it to the face, and it stays so for the
  session. Only the page's top frame draws it, and it leaves by itself when
  the extension stops checking in, so a session that ended leaves nothing.
  With the full bar off in Settings, a small bar takes its place: KOS's
  face and Stop, one press, beside the border and KOS's cursor; Take over
  is your own click, and the KOS icon and the side panel still say KOS is
  working;
- KOS's own cursor is KOS for Mac's, drawn and moved the same: the arrow
  in KOS's blue with its halo and KOS tag, gliding along the Mac's shallow
  arc, in the Mac's quick time (45 to 135 ms by distance). It is on the page
  from the session's start, in the middle until KOS points somewhere. It
  gets to each point before KOS acts there (a click, the field it types in,
  a hover, a drag), and ripples as it presses; it rests on what KOS scrolls
  to.
  It stays put between steps and across a new page in the tab, as a pointer
  does while the page scrolls under it. It goes while you have the tab and
  comes back on Hand back, and never takes your clicks. Your hand on the tab
  while it is on its way stops KOS's act, and nothing that could change the
  page is sent while you have it. Only its arrow is in KOS's own pictures,
  as the Mac's pointer is in its. It glides only on a tab in front, so it
  does while you type beside Chrome. The bar is drawn in the top
  layer, over what a page puts there, though a page's modal dialog still
  holds it, as it holds the rest of the page (the popup and the side panel
  stop KOS then);
- the pictures KOS takes never redraw the page you are looking at: a tab
  on screen is pictured from the frame Chrome already drew, made small as
  it is taken, and one that is not is captured as it is and made smaller
  by the extension;
- Chrome's own bar says the extension is debugging the tab, as it does for
  any extension that drives one;
- clicking or typing in one of its tabs yourself takes it over, in any of
  its frames, one from another site (a payment or sign-in frame) included,
  while KOS's own clicks in a frame stay KOS's (scrolling does not, unless
  you set it to in Settings, nor does anything in the 3 seconds after you
  press Allow or Hand back): KOS waits up to five minutes
  for you to press **Hand back**, and the idle limit does not run meanwhile;
- acting on a page asks you, trusted per site apart from KOS's own Chrome
  (a site trusted there is asked about again here, where you are signed in);
  in the side panel an approval offers **Always on** the site, and the
  mode chip beside the model (Shift+Tab in the box cycles it) sets the
  chat to **Ask** or **Auto**: in Auto, KOS goes ahead without asking for
  the risky steps of turns you start in that chat, in your Chrome and
  everywhere else, within what Auto never covers ([The chat's
  mode](#the-chats-mode));
- the session ends at its time limit, when idle, on Stop, when you close
  Chrome's debugging bar, when the connection to its KOS drops and is not
  back within 10 s, and when Chrome stops the extension's worker: the
  worker keeps the session's id beside its memory, and the next one to
  start lets its tabs go and tells KOS (`restarted`) in its hello.

## Security model

Everything in [computer.md](computer.md) holds: one-time pairing codes,
both keys proved on every connection, consent on the device, a bounded
session, unattended work off unless allowed. In addition:

- **Only its tabs.** A call names a tab, and the extension refuses any tab
  that is not in the session: ones it opened, and ones the owner handed it.
- **Only what the hands need.** Calls are DevTools protocol commands from a
  fixed list (reading the page, pointer and keys, navigation); everything
  else is refused, the browser-wide domains among them (other tabs, cookies
  of every site, downloads, the browser itself).
- **Not the overlay.** The bar's Take over, Hand back and Stop reach the
  extension from the overlay's own world, and only from the worlds Chrome
  made under its name; KOS may make one world of its own, `kos-hands`, with
  no more reach than the page. Its script runs, and its objects are made
  or reached, only in the page's own worlds and its hands', each one
  Chrome has told the extension it made; any other world, the overlay's
  among them, is refused, and so is one not heard of (a world just made
  is waited for, up to 200 ms).
- **Only the web.** A navigation goes to http, https or a blank page; a
  file, `chrome:` or an extension's page is refused.
- **Asking is the owner's, per KOS.** With Ask before each session off for a
  KOS, the extension tells it (consent `kos`, at hello and at once in a
  `state` frame), and KOS's `chrome.start` goes to the approval queue there
  instead, so a session is always allowed by someone.
- **Hidden sites stay hidden**: refused for opening and for every command
  while a tab is on one, and left out of the tab list and of the events. A
  host is matched as Chrome resolves it (lower case, punycode, one
  trailing dot dropped), and a `blob:` or `filesystem:` address by the
  address inside it. A side panel's read checks the tab again after the
  owner's answer and after the read, and gives nothing of a page that went
  elsewhere meanwhile.
- **What a field holds stays here.** A read of the DOM comes back without
  the browser's own shadow roots, whose text is each field's value, and a
  field a saved secret was filled into is said to hold `(hidden)` in the
  accessibility tree, with the editor inside it left out.
- **A saved secret is the extension's to put in** (Saved secrets, below).
- The keys: the extension's is made in the browser (WebCrypto Ed25519),
  kept in its own storage and never exported.

## Saved secrets

`secrets.fill` works in the owner's Chrome as in KOS's own browser
([secrets.md](secrets.md#the-tools)), with the same ask, grants, policy and
`secret_uses` row (`surface: chrome`, with the device). KOS's hands check
the page first, as they do at home (the ref from the last look, the
document, the page's origin and the field's frame, each frame around it
drawn, the field of the right kind), and mark the field. Then the value
goes in one call, `secret.fill`, the only one that carries one; the
scrubber that cleans every other frame KOS sends a device leaves it be.

The extension checks again, by what Chrome itself says of the tab (its
frame tree and DOM, through the debugger), never the page's word: the page
is on the origin approved and is https or this machine, its document is
the one approved, the field is in the frame approved and that frame is on
the frame origin approved, every frame around it is drawn and in view, no
service worker runs the field's frame or the page, and the field is one
the secret may go into (`fillable`: the right type, drawn, in view, on
top, enabled, writable, not in a form sent by GET). These checks and the
fill run in a world of the extension's own, `kos-secret`, which none of
KOS's commands can reach. The value is set through the native setter and
the events typing raises, on that node; only a page that refuses that is
typed into, and then only while the field has the keyboard before and
after. The field is checked to hold the value without reading it back,
and the answer is `{ filled: true }`. The value is dropped from the call
once read and never logged (the log says `secret.fill: filled`, or
refused and the code); no error holds it.

From then until the tab's document changes, and again whenever a document
a secret was in is come back to (back, forward, a reload, or an address the
document moved to by itself with `pushState`), the extension holds the
tab, whoever's session it is in: KOS's script step (a `Runtime.evaluate`
in the page's console mode or by unique context), every copy, cut,
select-all and paste key (Ctrl or Meta with A, C or X, Ctrl or Meta with
Insert, Shift with Insert or Delete) and every editing command that takes
text out (`copy`, `cut`, `selectAll`, `yank`, and the kill-ring deletes
`deleteToEndOf*`, `deleteToBeginningOf*`, `deleteWord*`), drags, and
typing or any editing command while a filled field has the keyboard (on a
page come back to, where no field is known, any editing command at all)
are refused (`tainted`). The accessibility tree says each filled field
holds `(hidden)`; on a page come back to, every text box. `tabs.list`
says what each tab is held to (`held`: the document and the addresses), so
a KOS that comes to the tab in a new session holds it in the host too,
and cleans and masks what was filled there.

Pictures change nothing in the page. Masking by restyling (a style
element, an attribute, a CSS highlight) is seen by the page's own script,
which could plant words it guesses at, watch which were masked, and learn
a filled value. So in a world of the extension's own in each frame it
reaches, the boxes that may show a secret are measured
(`packages/browser/src/boxes.ts`): on a held tab every text box, textarea,
editing host and select of every frame; and where KOS sends patterns
through `secret.picture`, in each frame on that pattern's origin, those
boxes and every stretch of text, SVG text and `::before`/`::after` (by the
element's attributes) that echoes one. A child frame's boxes are placed
where its element is drawn. The page is measured on both sides of a fresh
picture (never a frame Chrome drew before), pictured again if it moved, not
at all if it keeps moving, and the boxes are painted black on the picture
in the worker (`OffscreenCanvas`). KOS sends a value's pattern only to the
frames on the origins it was filled on (the page's and the field's
frame's), and a saved value's only to its own sites' frames. KOS sends a
picture through `secret.picture` whenever there is a value to mask; an
extension from before it shows no picture of such a page. The tab holds
are kept in session storage, so they outlive the worker's sleeps. KOS's
cursor hides its halo for every picture, masked or not (a `data-capture`
attribute on its own element), which tells a page nothing of a secret.

On every tab, held or not, a paste is refused (the `paste` and
`pasteAndMatchStyle` commands, Ctrl or Meta with V, Shift with Insert): it
would hand KOS whatever is on the owner's clipboard. No command reaches a
tab whose page is not a web address (one of Chrome's own, an extension's,
a file), however the tab got there, and a step back or forward to a
history entry that is not one is refused. A node found at a point is
never one inside the browser's own shadow roots, which hold each field's
text (`DOM.getNodeForLocation` with `includeUserAgentShadowDOM` forced
off). The approval of a fill names the device; one that runs while the
session is on another Chrome is refused (`refused:changed`).

Where it differs from KOS's own browser, it fails closed:

- **Service workers.** KOS clears a credential site's workers in its own
  profile; it never clears the owner's site data. So a page a service
  worker runs takes no fill in the owner's Chrome at all (`worker`), a
  site's own worker included; the owner fills that one themselves.
- **Scripts on credential sites.** KOS's script step does not run in the
  owner's Chrome (the extension does not pass on `Runtime.enable`, which
  it needs), so no document there is one a script of KOS's ran in; on a
  held tab the extension refuses it anyway.
- **Refs only.** Aiming by selector or text on a held page is refused by
  KOS's hands in the host, as at home; the extension cannot tell a ref
  from a selector in a command.
- **Copy keys** are refused on the whole held tab, not only on a filled
  field, and a filled field in a frame counts as having the keyboard while
  its frame's focus is on it.
- **What the page says.** A page that echoes a value into its own words
  (its title, a dialog, its text) sends it to KOS as any read of the page
  does; KOS's hands clean it out of everything they hand on, as at home.
- **Frames of another process** (many payment frames) are refused
  (`unreachable`); hand the tab to the owner.
- **Workers, checked once.** Whether a service worker runs the page is
  checked just before the value goes in. A page that registers one, or
  has one claim it, between that check and the value going in is not
  caught; the window is a few milliseconds, and the worker would have to
  be one the site meant to catch its own login.

What the owner's Chrome holds beyond KOS's reach: KOS's checks cover its
own hands, not everything else in the browser. Other extensions the owner
installed may read any page they have access to, the filled field among
them. The site the secret is for receives it, as it would if the owner
typed it. Chrome's own password and card managers may offer to save what
was filled, and that prompt is the owner's to answer. A crash dump of the
tab's renderer, if the owner sends Chrome's reports, may hold the page's
memory. KOS for Chrome holds the value for the call alone.

## Protocol

The device protocol, version 1, with `app.platform` `"chrome"`,
`permissions` `{ "tabs": true }` and no displays. Two frames are added for a
device whose host may put it to sleep (a service worker): the device sends
`{ "t": "ping" }` every 20 s and KOS answers `{ "t": "pong" }`. Pairing is
sent as `text/plain` (a request a page makes without a preflight), and KOS's
pair route may be read from any origin: the code is the proof. Its hello
carries `build`, from the `build.json` its package build writes beside its
code, and it takes the `update` frame and says `update.state` `reloading`
before it reloads ([computer.md](computer.md#builds-and-updates)).

| Method | Params | Result |
| --- | --- | --- |
| `session.begin` | `session`, `task`, `requester`, `conversation?`, `minutes` | `granted`, `until` |
| `session.end` | `session` | `{}` |
| `tabs.list` | `session` | `tabs [{ id, url, title, handed?, focus?, held? }]` (`focus`: the tab beside the side panel; `held { loader, urls }`: what a saved secret holds the tab to, Saved secrets above) |
| `tabs.open` | `session`, `url?` | `tab` |
| `tabs.close` | `session`, `tab` | `{}` |
| `cdp.send` | `session`, `tab`, `method`, `params?` | the command's result |
| `cdp.batch` | `session`, `tab`, `calls [{ method, params? }]` (1 to 100), `parallel?` | `results [{ result } or { error { code, message } }]`: in order, up to the first that fails, or all side by side when `parallel`; each checked as `cdp.send` checks one, as it is sent |
| `secret.fill` | `session`, `tab`, `node` (backend node id), `frame`, `doc` (the main frame's loader), `origin`, `frameOrigin`, `slot` (`password`, `username`, `card-number`, `card-expiry`, `card-exp-month`, `card-exp-year`, `card-cvc`, `card-name`, `address-*`, `token`, `text`), `value` | `filled: true`; refused with `origin`, `changed`, `field`, `unreachable`, `worker`, `focus`, `paused`, `hidden_site`, `tab` or `no_session`, never with the value |
| `secret.picture` | `session`, `tab`, `masks { <origin>: [pattern] }` (at most 500), `format?`, `quality?`, `maxEdge?` | `data`: the picture, masked (Saved secrets, above) |

A batch is refused as a whole, with nothing after sent, when at any
command in it the owner has taken the tab over (`paused`), the session has
ended (`no_session`) or the tab was taken back (`tab`); a command that goes
to a hidden site, or comes after a navigation to one, is refused on its own
(`hidden_site`). `Page.navigate` answers once its page is in, so what comes
next is checked against where the tab went.

`Page.captureScreenshot` takes one parameter of the extension's own,
`maxEdge`: the picture's longer side, in pixels. A tab's events go to KOS
as `cdp.event` (`tab`, `method`, `params`) only for what the hands listen
for; of the network, only the requests a page's answer waits on (its
documents, scripts and data), with their id, kind, url and when they began
and no headers, and the end of only those. Socket messages are not passed
on: a step in the owner's Chrome does not wait on them.

The side panel's calls take no session: they carry the chat, and the page
beside it when the chat asks.

| Method | Params | Result |
| --- | --- | --- |
| `chat.show` | `chat` and `conversation` (the chat shown, or null), `title`, `messages [{ role, text?, files?, quote? { text, from }, at?, steps? [{ summary, failed?, frame? }] }]`, `mode { mode, until?, sessions? }` (the chat's mode; `auto`, true in Auto, for a device from before modes), `notice? { text, from? }`, `pictures? { <frame id>: <base64 JPEG> }` (the newest four steps' pictures), `sites? { <frame id>: <host> }` (the page each shows) | `{}` |
| `chat.status` | `chat` and `conversation` (the chat the turn runs in, learned when it starts, never the one the panel moved to), `since?` (with `taken`: when the turn began, epoch ms, so a panel opened mid-turn keeps its clock), `waiting?` (`consent`: a device asks the owner for this chat's session; `approval`: an approval waits), `held` (the owner has control of its session), `said?` (the owner's words the turn is for), `taken?` (KOS has those words, said at once; ones said elsewhere are drawn on their way), `story?` (the turn told from its start: its steps so far, `› ` before each, ` (done)` after one that finished and ` (failed)` after one that failed, and what KOS says between them; empty before it has said or done anything; null when done), `error?`, `frame? { id, image, mediaType, site? }` (what a step just saw, with `said`, sent on its own to every device of the kind; a device never draws one whose `site` is on its hidden list) | `{}` |
| `chat.ask` | `chat`, `approval { id, tool, summary?, args?, mechanics?, why?, reason?, always?, expiresAt? }` (`summary`: the action in words with its ids named, as the Inbox titles it; `expiresAt`: when it lapses unanswered, epoch ms) | `{}` |
| `chat.settled` | `approval`, `outcome` (`approved`, `denied`, `expired`) | `{}` |
| `chat.chats` | `chats [{ id, title, updatedAt }]`, `current`; sent for `chat.list`, and unasked when one of the panel's chats gets a new title (with a `chat.show` too when it is the chat shown) | `{}` |
| `chat.models` | `current`, `choices`, `fixed?` (an engine that chooses its own), `error?` | `{}` |
| `chat.mentions` | `q`, `mentions [{ kind, id, label, hint? }]` | `{}` |
| `page.read` | `conversation` | `url`, `title`, `selection`, `text` |

The KOS for Mac chat window takes the same calls and sends the same
events, but reads no page ([computer.md](computer.md), the chat window).

A message's `role` is `you`, `kos`, `note`, or `steps` with `steps [{
summary, failed? }]`. `at` is when a `you`, `kos` or `note` line was
written to the chat, epoch milliseconds; a line kept before lines kept their
time has none, and a device shows no time for it rather than a guessed one. Every status carries the chat's `waiting` and `held`
as they stand, and a status without them clears them; one with none of
`said`, `taken`, `story`, `error` or `frame` says the state alone, and is
sent whenever it changes. A device draws no status or ask whose `chat` is
not the chat it shows.

A turn that carries on in a fresh query (its pictures full) tells
`› Looking again` as a step, done at its next one. A device's foot says the
running step, "Thinking" once the last step is done (or before any), and
"Working" after KOS's words. While a turn runs, `chat.show` leaves out the
steps it has written to the chat so far, which its story tells; a notice
that marks a wait on the owner or words the turn heard (`waiting`) does not
answer the turn, and a device keeps its story and pictures through it. A
panel opened mid-turn is told the story, then each of the newest four steps'
pictures as `frame` statuses.

`session.begin` answers as on a Mac. Granted in the panel with the site's
steps unasked, it says `auto { site }`, the host of the tab beside it:
KOS's approvals then let that session's steps on that site through without
asking, as Auto does for the chat, and the strict tools still ask. Not
granted, `reason` is `unanswered` (the owner's wait ran out, or the panel
closed) or `withdrawn` (KOS sent `session.end` for the ask, or Stop was
pressed in the panel); none is a no. `page.read` is refused with `no_panel` unless a panel
on that KOS shows that chat, `url` off the web and `hidden_site`; without
the grant to read pages it asks in the panel and waits up to the owner's
wait, then reads or answers `permission`. KOS refuses it itself under the
kill switch.

Events, besides `session.paused`, `session.resumed` and `session.ended`
(reason `owner`, `expired`, `idle`, `detached`, `host` or `restarted`):

| Event | Data |
| --- | --- |
| `cdp.event` | `session`, `tab`, `method`, `params` |
| `tab.closed` | `session`, `tab` |
| `tab.handed` | `tab`, `url`, `title`, `focus?` (sent outside a session too; `focus` when the owner spoke from the side panel beside it) |
| `chat.open` | `{}`: a panel opened on this KOS, and asks to be shown the chat |
| `chat.send` | `text`: the owner's words in the panel; `beside?`: the tab they were said beside, `{ kind: "page", url, title }`, `{ kind: "hidden" }` or `{ kind: "other" }` (not a web page), told to that turn (and taken into a running one with the words) and not kept; `quote? { text, from }`: what they selected on that page and its address, kept with the message; `files? [id]`: files sent ahead with `chat.attach`, to go with the words ([computer.md](computer.md), A phone) |
| `chat.attach` | `id`, `name`, `mediaType`, `part`, `parts`, `data`: one part of a file's base64, ahead of the `chat.send` that names it |
| `chat.stop` | `chat?`: the owner pressed Stop for that chat, or the one shown; `waited?`: how many ms ago it was pressed, when it waited on the way (KOS ignores it when the chat's running turn began after the press): its turn stops, its sessions end on every device, an ask for one is withdrawn, and the rest of the turn asks for none |
| `chat.decide` | `approval`, `approved` |
| `chat.list` | `{}`: asks for `chat.chats` |
| `chat.switch` | `conversation`: the panel continues that chat, and is shown it; a session the chat it left holds ends, once a turn running there ends |
| `chat.models` | `{}`: asks for `chat.models` |
| `chat.model` | `model`: KOS answers with it from now on, as the dashboard's picker sets it |
| `chat.mentions` | `q`, `kind?`: asks what an @ can name |
| `chat.mode` | `mode` (`ask` or `auto`), `until?` (epoch ms, or `task`: until the chat's running or next turn ends), `sessions?` (true: Auto also starts sessions a device leaves to KOS's approvals): sets the shown chat's mode, made now if there is none yet; anything else is ignored |
| `chat.auto` | `on`: a device from before modes; ignored, since Auto now covers far more than that switch did |

### The chat's mode

Every chat is in one of two modes, set from any surface's composer (a chip
beside the model, cycled by a press or Shift+Tab, with a menu) and kept
per chat on KOS, which alone decides what it lets through:

- **Ask**, the default: a risky step asks the owner, as it always has.
- **Auto**: a risky step of a turn begun from the owner's own words in
  that chat runs without asking, in KOS's own browser, the owner's Chrome
  and Mac within a session, and everywhere else. Each is kept in the
  Inbox's decided list and the audit log as approved by `auto mode`, never
  by the owner, the model is told it went ahead under Auto, so it says so,
  and an answer on Discord, SMS or iMessage starts with `(Auto)`.

Auto never covers, whatever the chat is set to (`autoCovers` in
`kernel/guarded.ts`, and the rules in `risk/beyondauto.ts`):

- what KOS refuses, Stop and the kill switch, which also sets every chat
  back to Ask;
- a call that places a secret, and a tool marked `asksAlways`;
- purchases and payments: an MCP tool named for paying (pay, purchase,
  checkout, charge, buy, order, transfer, send_money, refund, donate,
  subscribe), and a browser step whose tab or target address is a checkout
  or payment path, or whose page has a card field (`autocomplete` `cc-*`)
  or reads as a checkout (checkout, place order, buy now, pay now, payment),
  KOS's own browser steps and an MCP server's alike (`mcpBrowserStep`);
- a shell line unless every program in it is on a short list of reading,
  building and testing programs, called plainly (by name, not by a path;
  with no assignment before it but CI, NODE_ENV, FORCE_COLOR, NO_COLOR, TZ,
  LANG, LC_* or DEBUG), writing no file that is there outside scratch,
  and pointing no build, output or program it runs outside the workspace
  (`~` and `$HOME` are the workspace root) (`risk/shellauto.ts`). The list is not the boundary, the jail is: a line
  Auto lets through writes only where an approved one would (its home's
  folders, scratch, its own temp and caches), reaches this machine's
  loopback and nothing past it (a test server it starts, never KOS's
  ports), is sealed as a read-only line is (no signal to another process,
  no app opened, no Apple Event, no preference written, only a few mach
  services), and runs git held as a run nobody approved (`gitHoldEnv`: no
  hooks, no transport, no lazy fetch, and every program-naming setting
  pinned), so `git fetch`, `pull`, `clone` and installs ask, saying they
  need the network. In the container no shell line is
  covered: the container is the jail there, a command runs unwrapped beside
  KOS, and nothing narrower holds the network or KOS's ports. The same
  goes for `python.run` wherever the macOS jail does not hold it.
  An Auto line also writes no repository's config, hooks, info, modules or
  worktrees, no `.git` file and no git global config under the workspace
  (`GIT_CONTROL_WRITES`, `gitGlobalConfig`), nothing of `.kos` but its temp
  and caches, and no `.env`; and it reads none of KOS's settings or a
  `.env`. `git add` and `git commit` still work;
- deleting for good: `files.rm` of a whole folder, `files.mv` onto a file
  that is there; a shell line with
  `rm -r`, a forced push, `git reset --hard`, `git clean`, `dd`, `mkfs`,
  a recursive `chmod` or `chown`, or a `>` onto an existing file outside
  scratch; `systems.project_delete`, `chats.delete`, `blobs.remove`,
  `daemons.remove`, `discord.prune`; an http DELETE; an MCP tool named for
  deleting, cancelling or revoking;
- a write into another project's or a blob's folder, or a project's
  command asking to write the whole workspace (the reach rule's
  `beyondAuto`, `tools/home.ts`);
- an MCP tool named for sending or publishing (send, post, message, email,
  mail, reply, publish, tweet, comment, invite, share), and an `http.fetch`
  with a body or a method past GET and HEAD to a host off the owner's list;
- a message to anyone but the owner (`notify` to a channel or a user) and
  opening a place to others (`discord.audience` past the owner,
  `discord.access`);
- changing KOS itself or what runs without the owner: `skills.commit`,
  `skills.promote`, `modules.instantiate`, `modules.create`,
  `modules.promote`, `daemons.create`, `daemons.start`, `sites.create`,
  `cron.schedule`, `builds.run` (a coding agent that runs on its own);
- speaking in public on the server: `discord.react`, `discord.role`;
- `browser.eval` and `browser.handoff`;
- typing on a computer after it reported a password field, until a click
  or key there goes through;
- any turn but the owner's own words in that chat: a schedule's run, a
  guest's words, a dispatch, a handoff, an aside or a resumed approval.

An ask raised in a chat set to Auto for one of these says so on every
card: its reason reads "asked though the chat is in Auto: ..." and it
carries `beyondAuto`, so no surface offers Always for it and the card's
note says Auto never covers it.

Starting a session is covered only with `sessions`, and only on a device
that leaves its sessions to KOS's approvals (consent `kos`): a device that
asks on itself still asks there, since consent lives on the device and
nothing KOS sends changes that. A device's time limits and idle limit still
apply. A step on a Mac's screen under Auto is judged risky, so Auto's yes to
it is kept like any other.

Auto lasts until turned off, until its `until` passes, or, with `until`
`task`, until the chat's running or next turn ends. Every `chat.show`
carries the mode as it stands, and each device of a chat is shown it again
when it changes elsewhere.

Error codes beyond the device protocol's: `tab` (not a tab of the session),
`method` (not on the list), `url` (not the web), `hidden_site` (the owner
hid it), `tainted` (the tab holds a saved secret), and a fill's own
(`secret.fill`). A tab on a hidden site is listed as `{ id, url: "", title: "Hidden
from KOS", hidden: true }`. Unpairing sends `{ "t": "unpair" }` first, as
KOS for Mac does.
