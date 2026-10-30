# The browser

`@kos/browser` (packages/browser) is how KOS drives a web browser: the
Chrome it runs, the live view the dashboard watches, and the hands an agent
uses, all over Chrome's own DevTools protocol (CDP) on one connection. The
`browser.*` tools in the harness are made of it.

## The one Chrome

KOS runs a single Chrome, headless unless Settings > Browser shows its
window, on DevTools port 9225 (`KOS_BROWSER_PORT` names another, for a
second KOS on the same machine), with its profile in `.kos/browser-profile`
under the workspace. A Chrome already answering on that port is adopted.
Each conversation browses in a tab of its own, each tab in a window of its
own so every page paints at once. A popup belongs to whoever's page opened
it. Tabs nobody has used for twenty minutes are closed; the owner's own
tabs stay until the owner closes them.

Sign-ins survive restarts. Chrome forgets a cookie with no expiry when it
quits, and KOS's Chrome quits whenever KOS does, so every minute, and
before Chrome is closed, KOS gives each such cookie an expiry thirty days
out (`cookies.ts`). Chrome then keeps it with its other cookies, encrypted,
in the profile. When KOS stops, Chrome is closed properly rather than left
to be killed.

Unpacked extensions named in Settings > Browser are loaded over the
protocol at each start (`Extensions.loadUnpacked`), since Google Chrome 137
and later ignores `--load-extension`.

## The hands

A tab's `Page` (`page.ts`) does what an agent asks of it:

- **Looking.** The page is read from Chrome's accessibility tree: the role
  and name a screen reader would announce. The index lists what can be
  acted on, one line each with a ref (`@e12`); a dialog's controls come
  first, since a page with one open is waiting on it. A ref stays the
  same for the same element while its document lives. Frames in the
  page's own process are read into it; one that is not is named as
  unread. The outline (`then: "snapshot"`) has everything, the reading
  (`then: "read"`) the page's text and links.
- **Acting.** Clicks are real input events at the middle of the element,
  after it is scrolled into view. A click that would land on something
  else (a banner over the button) is refused, naming what is in the way
  and its ref. Fill replaces a field's text, type adds to it; a field
  typing does not reach (a date) is set the way a framework notices.
  Keys go as Chrome wants them, with editing shortcuts as the commands
  they are. After each step the page is given time to settle: a
  navigation the step started, then a quiet network.
- **Never hanging.** Every wait has a deadline and ends in an answer: a
  page still loading at twenty seconds is handed back as it is, said to
  be still loading. A dialog is answered the moment it opens (an alert
  closed, a confirm dismissed unless a step said to accept), since an
  open one holds every later command on the tab, and the agent is told
  what it said. A crashed tab is loaded again. Calls on one tab run one
  at a time.

## Watching and taking over

The dashboard watches a tab as a screencast, up to 30 frames a second,
over its one WebSocket (`/api/socket`), each frame as bytes rather than
text; a frame that cannot go out at once is dropped, not queued, so what
is on screen is never behind. The socket lets in the dashboard's own page
only (a WebSocket is not held to the same-origin rule, so the origin is
checked), and the dashboard's token when it has one.

Taking over holds the tab: the owner's input is the only input on it, and
an agent's next call on it, or its next step, waits until the owner lets
go (ten minutes at most, then it is told the owner still has it). The
window that took it letting go, closing, or losing its connection lets go.

## What an agent may do

Only http and https pages (and `about:blank`) open for an agent; a file
or the browser's own pages do not, which keeps the workspace jail whole.
Looking is safe; acting asks the owner until the site the tab is on is
trusted, and the trust is kept per site for every browser action
(`browser.*` on `site:<host>`); a script in the page, and the ask for the
owner's hands, ask every time. Whatever came from the page reaches the
model between markers with a fresh id, saying it is the page's words and
not instructions.

## Tests

`engine.chrome.test.ts` drives a real headless Chrome against pages it
serves: a form filled, picked, checked and sent by refs, a confirm
answered both ways, a covered click refused, a link followed and gone
back from, a page that never finishes loading. It is skipped where no
Chrome is installed.
