# KOS in your Chrome

KOS has a Chrome of its own (see [browser.md](browser.md)). The **KOS
extension** lets it work in yours: the one you are signed in to everything
with, on your laptop, while you watch. It is a device, paired and proved the
way KOS Device is (see [computer.md](computer.md)), that offers tabs instead
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
   that chat's browser tools work in your Chrome; `chrome.end` gives it back.

To give KOS a tab you are on, click the KOS icon there and press Give this
tab to KOS. The extension needs no access to your sites to work in a tab: it
asks Chrome for the debugger, tabs, tab groups, the side panel and its own
storage. Reading a page for the side panel's chat is the one thing that
needs more, and it is asked for there, once, when you allow it.

### The side panel

The panel button in the popup opens a chat with KOS beside your tabs, as
Claude in Chrome does. It is one more surface, `chrome`, carried on the
pairing's own line: one stream like iMessage's, shown on the dashboard as
Chrome, with `/new` behind the pen. The chat is the one KOS keeps, so a turn
taken on the dashboard shows in the panel too, each turn's steps fold to a
line you can open, and an approval the chat asks for is decided in place.

- **Reading the page.** KOS reads the tab beside the panel with
  `chrome.page` when your words are about it: its address, title, what you
  selected and its text. Only the panel's chat can, only while the panel is
  open on that chat, never on a hidden site, and only once you press Allow
  in the panel (Chrome's grant to read sites, asked for once).
- **Working in the tab.** When the chat needs to act, `chrome.start` asks in
  the panel, not in a window, and the session works in the tab beside it,
  where you are looking, instead of in KOS's own window. Speak from another
  tab while it lasts and KOS works there instead. The border, the bar, Take
  over and Stop are the same as any session's, and Take over and Stop are
  in the panel too.

The popup is laid out as KOS Device's window is, with KOS's face moving as
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
  the idle limit, whether scrolling a KOS tab pauses KOS, whether each KOS
  connects when Chrome opens, the time left on the KOS icon, and Copy log.

While KOS works in your Chrome:

- it works in a window of its own, its tabs grouped as **KOS**, and in any
  tab you gave it; no other tab is reachable;
- each of those tabs has a glowing border and a small bar saying what KOS
  is doing, with **Take over** and **Stop**;
- Chrome's own bar says the extension is debugging the tab, as it does for
  any extension that drives one;
- clicking or typing in one of its tabs yourself takes it over: KOS waits
  until you press **Hand back**;
- acting on a page asks you, trusted per site apart from KOS's own Chrome
  (a site trusted there is asked about again here, where you are signed in);
- the session ends at its time limit, when idle, on Stop, when you close
  Chrome's debugging bar, and when the connection to its KOS drops.

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
- **Only the web.** A navigation goes to http, https or a blank page; a
  file, `chrome:` or an extension's page is refused.
- **Asking is the owner's, per KOS.** With Ask before each session off for a
  KOS, the extension tells it (consent `kos`, at hello and at once in a
  `state` frame), and KOS's `chrome.start` goes to the approval queue there
  instead, so a session is always allowed by someone.
- **Hidden sites stay hidden**: refused for opening and for every command
  while a tab is on one, and left out of the tab list and of the events.
- The keys: the extension's is made in the browser (WebCrypto Ed25519),
  kept in its own storage and never exported.

## Protocol

The device protocol, version 1, with `app.platform` `"chrome"`,
`permissions` `{ "tabs": true }` and no displays. Two frames are added for a
device whose host may put it to sleep (a service worker): the device sends
`{ "t": "ping" }` every 20 s and KOS answers `{ "t": "pong" }`. Pairing is
sent as `text/plain` (a request a page makes without a preflight), and KOS's
pair route may be read from any origin: the code is the proof.

| Method | Params | Result |
| --- | --- | --- |
| `session.begin` | `session`, `task`, `requester`, `conversation?`, `minutes` | `granted`, `until` |
| `session.end` | `session` | `{}` |
| `tabs.list` | `session` | `tabs [{ id, url, title, handed?, focus? }]` (`focus`: the tab beside the side panel) |
| `tabs.open` | `session`, `url?` | `tab` |
| `tabs.close` | `session`, `tab` | `{}` |
| `cdp.send` | `session`, `tab`, `method`, `params?` | the command's result |

The side panel's calls take no session: they carry the chat, and the page
beside it when the chat asks.

| Method | Params | Result |
| --- | --- | --- |
| `chat.show` | `conversation` (or null), `title`, `messages [{ role, text?, files?, steps? }]`, `notice? { text, from? }` | `{}` |
| `chat.status` | `conversation`, `story` (the turn's steps so far, `› ` before each; null when done), `error?` | `{}` |
| `chat.ask` | `approval { id, tool, args?, why?, reason? }` | `{}` |
| `chat.settled` | `approval`, `outcome` (`approved`, `denied`, `expired`) | `{}` |
| `page.read` | `conversation` | `url`, `title`, `selection`, `text` |

A message's `role` is `you`, `kos`, `note`, or `steps` with `steps [{
summary, failed? }]`. `page.read` is refused with `no_panel` unless a panel
on that KOS shows that chat, `url` off the web, `hidden_site`, and
`permission` until the owner allows reading pages; KOS refuses it itself
under the kill switch.

Events, besides `session.paused`, `session.resumed` and `session.ended`
(reason `owner`, `expired`, `idle`, `detached` or `host`):

| Event | Data |
| --- | --- |
| `cdp.event` | `session`, `tab`, `method`, `params` |
| `tab.closed` | `session`, `tab` |
| `tab.handed` | `tab`, `url`, `title`, `focus?` (sent outside a session too; `focus` when the owner spoke from the side panel beside it) |
| `chat.open` | `{}`: a panel opened on this KOS, and asks to be shown the chat |
| `chat.send` | `text`: the owner's words in the panel |
| `chat.decide` | `approval`, `approved` |

Error codes beyond the device protocol's: `tab` (not a tab of the session),
`method` (not on the list), `url` (not the web), `hidden_site` (the owner
hid it). A tab on a hidden site is listed as `{ id, url: "", title: "Hidden
from KOS", hidden: true }`. Unpairing sends `{ "t": "unpair" }` first, as
KOS Device does.
