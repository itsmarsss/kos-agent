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
tab to KOS. The extension needs no access to your sites: it asks Chrome for
the debugger, tabs, tab groups and its own storage, nothing more.

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
  Chrome's debugging bar, and when the connection drops.

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
| `tabs.list` | `session` | `tabs [{ id, url, title, handed? }]` |
| `tabs.open` | `session`, `url?` | `tab` |
| `tabs.close` | `session`, `tab` | `{}` |
| `cdp.send` | `session`, `tab`, `method`, `params?` | the command's result |

Events, besides `session.paused`, `session.resumed` and `session.ended`
(reason `owner`, `expired`, `idle`, `detached` or `host`):

| Event | Data |
| --- | --- |
| `cdp.event` | `session`, `tab`, `method`, `params` |
| `tab.closed` | `session`, `tab` |
| `tab.handed` | `tab`, `url`, `title` (sent outside a session too) |

Error codes beyond the device protocol's: `tab` (not a tab of the session),
`method` (not on the list), `url` (not the web).
