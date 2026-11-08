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

- **Looking.** The index lists what can be acted on, one line each with a
  ref (`@e12`): the role, name, state and value a screen reader would
  announce. The page finds it itself, in one call, from a world of KOS's
  own beside the page's (`inpage.controls`), so a page of thousands of rows
  costs what its first sixty controls do, not its whole tree: rendered
  controls only, through open shadow roots and the frames it can reach;
  a frame of another origin is read in a world of its own, side by side
  with the rest, and one in another process, or still loading its page,
  is named as unread, as is a part of the page in a closed shadow root,
  which no script reaches (the outline reads it). A control the page marks
  as presentation is kept when it can still be focused, and what an element
  owns by `aria-owns` is read inside it, as a reader does. Text a page draws
  with CSS (`::before`, `::after`) is not read into a name: a control named
  only by an icon font or generated content shows unnamed, where the
  outline would name it. A dialog's controls come first, under the start
  of its name (60 characters), since a page with one open is waiting on
  it. A ref
  stays the same for the same element while its document lives. The
  outline (`then: "snapshot"`) is Chrome's accessibility tree, everything
  on the page, and so is the index on a KOS for Chrome too old to make a
  world; the reading (`then: "read"`) is the page's text and links.
- **Acting.** Clicks are real input events at the middle of the element,
  after it is scrolled into view. When something sits over that point (a
  bar the page keeps at its edge, over what was just scrolled there), the
  element is brought to the middle of the view, then other parts of it are
  tried; only one covered everywhere is refused, naming what is in the way
  and its ref. A hit counts what a real press would: anything the pointer
  passes through (`pointer-events: none`) is not in the way. Besides
  clicks: `dblclick`, `rightclick`, and `drag` from one target to another,
  pointer moves for a slider and, for a page using the browser's own drag
  and drop, the drag Chrome would have started. A target may be a ref, a
  CSS selector, or a text selector as Playwright writes one
  (`button:has-text('Submit')`, `text=Submit`). Fill replaces a field's text, type adds to it; a field
  typing does not reach (a date) is set the way a framework notices.
  Keys go as Chrome wants them, with editing shortcuts as the commands
  they are. After each step the page is given time to answer: a
  navigation the step started, to DOMContentLoaded, then the document
  still for 150 ms (watched from KOS's world) with no request open that
  the page's answer waits on: data it fetches from any site, and its own
  documents and scripts, that the step started (or that began just
  before it, for a second at most). Not pictures, beacons, others'
  scripts or streams; not a request open three seconds, which is a long
  poll; not an address the page asks again and again, which is a poll
  (three times in ten seconds, counting the times it asked between steps
  and since this one, not during earlier ones). At most 800 ms, or 2.5 s
  while a request the step started is still coming, and a step that ends
  with one still open says the page may still be loading. Typing and keys
  give at least 400 ms, for a field that searches a moment after the
  typing stops, paid once for fields filled in turn (a type, fill, select
  or check next leaves it to that step); once a request ends or a socket message comes, 60 ms more
  for the page to show what it brought. Requests are dated by the
  browser's clock, so one heard late is not taken for the step's. So a
  run needs no waits of its own after clicks, and a page that never stops
  talking does not hold every step. Stop ends the step under way: a wait
  is woken, a command still out is no longer waited for (what it brings
  back later is released), no further one is sent, a drag lets go of the
  button, and the run says it was stopped.
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
