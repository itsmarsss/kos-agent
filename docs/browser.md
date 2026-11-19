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
tabs stay until the owner closes them, and so does every tab of a
conversation the owner holds or watches one of.

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
  with the rest; one of another site, which Chrome runs in a process of
  its own (most payment frames), through that frame's own session (below);
  one still loading its page, or one no session reaches, is named as
  unread, as is a part of the page in a closed shadow root, which no
  script reaches (the outline reads it, and leaves frames of other
  processes out). A control the page marks
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
  typing stops, paid once for fields typed into in turn (a type, fill or
  press next leaves it to that step; a pick or a tick does not); once a request ends or a socket message comes, 60 ms more
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
  closed, a confirm dismissed unless a step said to accept), since an open
  one holds every later command on the tab, and the agent is told what it
  said (a note that comes again is told once, with how often, and twenty
  kinds of dialog at most are kept between its calls). A crashed tab is loaded
  again. Calls on one tab run one at a time.

- **Secrets.** `Page.fillSecret(ref, value, expect)` is the one way a
  saved secret goes into a page (the `secrets.fill` tool, see
  docs/secrets.md), apart from `fill`: the ref must be from this
  document's last look; the page's origin and the origin of the frame the
  field is in, read from the browser's own DOM tree and frame tree, must be
  the ones approved; each frame around the field must be drawn and in
  view; and the field (`inpage.fillable`, in KOS's own world) must be an
  input of a type the secret fits (a password only into `type=password`, a
  card number, a key or a note only where its autocomplete or label says
  so), at least 8 by 8, not see-through, in view and on top at its middle,
  enabled and writable, and not in a form the browser sends by GET (its
  `method` property: no method or one it does not know is GET; or any
  submit button in it with `formmethod=get`). The value is set on
  that node itself, through the native setter and the events typing
  raises, so it cannot land wherever the keyboard is. Only a page that
  throws that away gets real typing, and then only while the field has the
  keyboard before and after (`document.hasFocus()` and the frame's focused
  element); a page that moves it is refused as `focus`. Either way it is
  checked to hold the value by a yes or no from KOS's world, never read
  back.
  A field in a frame of another process (most payment frames on the web)
  is reached through that frame's own session: its origin is the one that
  session says it committed, each frame element between it and the page is
  checked drawn and in view in its parent's session, and the value is set
  in a world of KOS's own there. Nothing thrown holds the value. A Page made with `putSecret` (the owner's
  Chrome, through KOS for Chrome) hands the value to it after these
  checks instead of setting it itself: the extension checks again on its
  side, puts it in and sees that the field holds it
  (docs/browser-extension.md, Saved secrets). The page is tainted the
  same way either way.
- **A tainted page.** Once a secret is in (a password, a card's number,
  expiry or CVC, a token, a note; not a username, a name or an address),
  the page is tainted until its document changes: its secret fields read
  as `(hidden)` in the index and the outline; Meta or Ctrl with c, x or a
  while a secret field has the keyboard, a key that types or deletes in
  one, typing or filling into one, a drag, and any target but an @ref (a
  CSS or text selector, a look's or a read's scope, a wait for words or a
  selector), which could find the value by guessing at it, are refused. A document is also known by its
  address (less its fragment): history coming back to one a secret was in
  (back, forward, a reload) may restore what was typed, so it is held
  tainted, the whole page, though which field holds the secret is no
  longer known.
- **A credential site.** On a site a saved secret may be filled on
  (the `evalBlocked` predicate the host gives `BrowserLive`, from the
  vault), `browser.eval` is refused in every tab whatever the page holds,
  and a document a script of KOS's ran in is refused a fill (`scripted`),
  as is every tab joined to it by an opener. Every saved value (the
  `saved` values the host gives) is cleaned from every tab's words; a
  page's pictures are masked only for the values it may be sent
  (`savedFor`, those of secrets for its site, and the conversation's
  filled ones). Service workers on credential sites are cleared at attach
  and when a site is listed (`purgeWorkers`); a list of them that has not
  gone quiet in three seconds leaves the sites uncleared, and they take no
  fill. See docs/secrets.md.
- **A conversation's tabs together.** A popup can read its opener, and
  any tab can echo what another sent, so the secrets are held per
  conversation (`Kin`, from `BrowserLive`, popups adopted into the
  conversation of the tab that opened them): while any of its tabs is on
  a tainted page, `browser.eval` and a `data:` address are refused in
  every one, and the values filled in any are kept for the conversation's
  life. What a tab holds is kept for the tab's life, through its hands
  being made again after a detach, and another conversation does not take
  (`browser.use_tab`) a tab of one that filled a secret, nor one the owner
  holds. Every place any page of any of its tabs echoes one (its text, its
  title, its address, a dialog, a script's answer) reads as `(hidden)`,
  as typed, percent encoded in either case of hex (as an address or a
  form carries it, a space as `+`) or JSON escaped. Every picture of
  those tabs (what the model is shown, an approval's, a kept frame) is
  painted over where it may show a secret, the page itself never
  changed: a restyle, an attribute or a highlight is seen by the page's
  script, which could plant guesses and learn which matched. In KOS's
  world in every frame it can reach, every root (the documents and every
  shadow root, closed ones too, listed from the browser's own tree) is
  measured (`boxes.ts`, `inpage.secretBoxes`): text boxes, textareas,
  editing hosts and selects, every echo of a value in text, SVG text
  holding one, and an element whose attributes hold one that draws a
  `::before` or `::after`. A child frame's boxes are placed where its
  element is drawn; one of another process is measured in its own
  session and placed through each frame element between it and the page
  (`DOM.getFrameOwner` and the element's box in its parent's session).
  The page is measured on both sides of the picture,
  taken again if it moved and not at all if it keeps moving, and the
  boxes are painted black on the PNG in the host (`paint.ts`), sent as a
  JPEG. A frame is sent the patterns of only the values filled on its
  origin (the page's and the field's frame's at the fill) and the saved
  ones for its site. A page that cannot be measured is not pictured.
  On a tab holding a secret, and in any frame given a pattern, every text
  box is painted over, not only those that hold a value: a box's value is
  not read to decide.
  The owner's own screencast of the tab is not masked.

- **Frames of other processes.** A frame of another site runs in a
  process of its own, which the tab's session does not reach: the tab
  lists it in its DOM with its frame's id and no document, and leaves it
  out of its frame tree. Each tab's session has Chrome attach such frames
  as sessions of their own as they come (`Target.setAutoAttach`, flattened,
  iframes only, the page not held), each such session in turn, and KOS
  reads the tab as the parts its sessions hold (`frames.ts`), joined where
  a frame's element sits in its parent's part. A backend node is its
  process's own, so a ref names its part too. Its frames' navigations are
  heard on its session, for KOS's worlds there, which are made afresh
  each call, and a session that detaches (a frame gone to yet another
  site) takes its worlds and its filled fields with it. A click on an
  element there is aimed in the tab where the frame is drawn, and checked
  to land on each frame's element on the way before it lands on the
  element; keys go to the tab, which sends them where the keyboard is,
  followed down each frame's focus, through their sessions. Everything a
  tainted page refuses, it refuses there too. `browser.eval` is held to
  the frames of the tab's own process, as a script in the page reaches no
  other; the document it ran in takes no fill, whatever frame the field
  is in. A challenge's frame (Turnstile, reCAPTCHA, `isChallenge`) stays
  attached but is never looked into. A frame no session reaches is
  painted over whole in pictures. Pictures read the frames' trees first
  and the DOM only when something is to be painted, and a fill keeps to
  the sessions it read where the field is.
  The browser hits a point of a part's document, not its viewport, so a
  hit test is moved by how far that part is scrolled.

## Watching and taking over

The dashboard watches a tab as a screencast, up to 30 frames a second,
over its one WebSocket (`/api/socket`), each frame as bytes rather than
text; a frame that cannot go out at once is dropped, not queued, so what
is on screen is never behind. The socket lets in the dashboard's own page
only (a WebSocket is not held to the same-origin rule, so the origin is
checked), and, when KOS has a dashboard token, a tab holding it: a
browser's socket sends no headers, so the tab opens it with a one-time
ticket from `/api/sign`, good for a minute, and the token never goes into
its address.

Taking over holds the tab: the owner's input is the only input on it, and
an agent's next call on it, or its next step, waits until the owner lets
go (ten minutes at most, then it is told the owner still has it). The
window that took it letting go, closing, or losing its connection lets go.

## What an agent may do

Only http and https pages (and `about:blank`, and `data:` while no tab of
the conversation holds a secret) open for an agent; a file, a
`javascript:` address or the browser's own pages do not, which keeps the
workspace jail whole. `Page.goto` checks every address itself (`urlFor`,
`address.ts`), so no way of navigating gets around it: back and forward go
only to an entry it would open, and the dashboard's address bar is held to
the same. Where a tab is comes from the browser's history, not the page's
script.
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
back from, a page that never finishes loading. `persite.chrome.test.ts`
tries what the per-site rule stops: a script before a fill, another
conversation reading the site's own copies, a script after leaving the
page, a service worker, a restart. `fillsecret.chrome.test.ts`
fills a login and a card in a frame of another origin, and a card, its
expiry and CVC in a frame of another site (localhost in a page on
127.0.0.1: a process of its own), clicks there, holds and paints it as
any frame, and is refused it on an origin not approved; it is refused a
wrong origin or frame, a page changed since, a field of the wrong kind, a
hidden, tiny or read-only one, and a form sent by GET however it says
so; checks what a tainted page hands back and refuses (a `javascript:`
address, a popup reading its opener, a page come back to by history, an
address carrying the value encoded), and counts the magenta of the
secrets in its pictures, closed shadow roots, selects, SVG text and
pseudo-elements among them. They are
skipped where no Chrome is installed, and run Chrome with
`--use-mock-keychain`, since under a test's HOME it would ask the Mac for
a keychain.
