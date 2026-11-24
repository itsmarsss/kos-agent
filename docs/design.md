# Design language

KOS shows itself in three places: the dashboard (packages/ui), the Chrome
extension (packages/browser-extension: popup, consent window, side panel)
and KOS for Mac, the Mac app (packages/device-macos). They are one product,
so they share one look. This is that look, written down. Where the three
used to disagree, the best of them was kept, and this says which.

The values live once, in `packages/shared/src/design.ts`. The dashboard's
`styles.css`, the extension's `kos.css` and KOS for Mac's `Theme.swift` each
declare them, as do the overlays KOS draws over a page (`overlay.ts`) and
over the screen (`Palette.swift`), and a test (`design.test.ts`) fails when
one of them drifts.

The web pieces live once too. `@kos/kit` (packages/kit) holds the React
components the dashboard and the extension both draw: KOS's face, the
markdown KOS speaks in, one set of icons, Pill, Tag, Switch, Chips,
IconButton, Card, Empty, the label, the working dots, Section, Collapse and
DrawerRow, with their motion, and `kit.css`, which each app loads before
its own sheet. [components.md](components.md) lists every piece and where
each of the three apps keeps it; use one from there before drawing one. A surface says only
what is its own: the dashboard where a reference leads (`refs.tsx`), the
extension nothing, so its references are chips that go nowhere.

## Principles

- **Quiet surfaces, one loud thing.** Dark panels, thin lines, muted text.
  The accent is kept for the one thing on screen to act on, or the one that
  is chosen.
- **Borders separate, shadows float.** A card is a fill and a 1 px line.
  Only what floats over the page (a menu, a popover, a toast) casts a shadow.
- **Everything answers the pointer.** Lighter under it, a touch smaller
  pressed, in the same time everywhere.
- **Shapes nest.** A corner inside a corner follows it (see Shape).

## Colour

Two palettes, dark and light, the same hexes on all three. Dark is below;
light is `LIGHT_COLOURS`, after the tints.

| Token | Value | For |
| --- | --- | --- |
| `bg` | #0c0e12 | the window, a field's well |
| `panel` | #12151c | cards, the composer, menus |
| `panel-2` | #181c26 | a control at rest, a row under the pointer |
| `line` | #262b36 | borders |
| `line-strong` | #3a4150 | a border under the pointer, a switch that is off |
| `text` | #e7ebf3 | words |
| `muted` | #8b93a7 | secondary words, a quiet control |
| `faint` | #758095 | labels, placeholders, times; 4.5:1 on `bg` and `panel` in both palettes, held by `design.test.ts` |
| `accent` | #7c9cff | the thing to act on, the chosen thing, links |
| `accent-lit` | #9bb4ff | the accent under the pointer |
| `on-accent` | #0b0e14 | words on the accent |
| `violet` | #a57cff | references to KOS's own things (@mentions), who said it |
| `ok` / `warn` / `danger` | #3ecf8e / #e6b84d / #f07178 | how something went |

Tints are a token mixed into transparent, at five strengths only:

| Strength | Mix | For |
| --- | --- | --- |
| quiet | 8% | the fill of a box that holds a question or a task |
| dim | 14% | a pill, a tile, a chosen chip or row, a mention |
| strong | 18% | the owner's message |
| soft | 25% | a border at rest: the task box, a danger button |
| edge | 45% | the border of something chosen, live or under the pointer |

A danger button under the pointer fills to 17%, between dim and strong, and
that is the one exception.

The KOS face is its own colour, not the accent: hue 214, #3585ed, ink
#141d29, from `@kos/shared` (`face.ts`); KOS for Mac's `KOSFace.swift` ports it.
KOS's cursor and the border it draws while working are the accent.

Light: all three also have a light palette (`LIGHT_COLOURS`, and
`Theme.swift`'s `Light` on the Mac), chosen in Settings on each: Appearance
on the dashboard, Theme in the extension and in KOS for Mac, both of which
follow the dashboard's by default. Light's ok and warn are darker (#0f6e45,
#7d5400) so a pill's text on its own tint still reads at 4.5:1.

## Type

The system font on all three: SF on the Mac (`-apple-system` on the web),
`system-ui` elsewhere. Code and ids in the system monospace (`ui-monospace`,
SF Mono). The dashboard no longer loads IBM Plex.

One ladder of sizes, in points: 10.5, 11, 12, 12.5, 13, 15, 17, 22.

| Role | Size and weight |
| --- | --- |
| section label | 10.5, 600, uppercase, 0.08em, `faint` |
| pill, time, small print | 11, 500 |
| chip, hint, meta | 12, 500 |
| button | 12.5, 600 |
| body | 13, 400, line height 1.45 |
| title (a window's, a card's head) | 15, 600 |
| heading (a sheet's, a workspace's head) | 17, 700 |
| page heading | 22, 700, -0.02em |

Weights are 400, 500, 600 and 700, nothing between. The two headings take
their weight from `--title-weight` (700) on the web, so a sheet, a chat's head
and a page's title agree; a card's or a panel's title stays at 600.
`design.test.ts` fails on any other weight in the web sheets.

The dashboard is a full window read at arm's length, so its body sits one
step up the ladder (`--text-md`, 14 at the default density) and its density
setting scales the whole ladder. The roles and their order are the same.
Both web surfaces declare the dashboard's steps as `--text-xs` to
`--text-2xl` (`TYPE` in design.ts), which the kit's pieces are set in.

## Shape

Radii: 4 (code, a keycap), 7 (a control: button, field, chip, menu row),
10 (a card, a menu, a popover), 14 (a sheet, the composer, a message
bubble), and the capsule (pill, switch, a button inside something round).
Corners are continuous on the Mac. On the web they are only the tokens
(`--r-xs`, `--r-sm`, `--r-md`, `--r-lg`), a capsule (999px) or a share of
the box (50%); `design.test.ts` fails on a literal corner, and there is no
second set beside them.

Two rules for a shape inside a shape:

1. **Concentric.** Inner radius = outer radius - the gap between them. A
   menu is 10 with 3 px of padding, so its rows are 7. A tile inside a card's
   padding of 12 or more is far enough in to be its own shape.
2. **Round holds round.** Inside a capsule, or a container rounder than 10
   with a small gap (the composer, the session bar), a control is a capsule
   and a lone symbol is a circle. A 7 px corner fights a round edge.

## Space

Steps of 2: 2, 4, 6, 8, 10, 12, 14, 16, 20, 24.

- Window gutter 20; a narrow window (popup, side panel) 16.
- Card padding 12 by 14, its rows 10 apart; sections 14 apart, a label 8
  above its card.
- Button 6.5 by 12, chip 5.5 by 10, field 8 by 10, pill 3 by 8.

## Elevation

Borders, not shadows, for everything that sits on the page. What floats has
one shadow, `0 12px 32px rgba(0,0,0,0.45)` (`--float` on the web, the only
drop shadow the sheets may cast; a ring or an inset line is a border drawn
another way), and a `line-strong` border. Focus
is a 2 px accent outline 1 px out, or on a field its border turns accent with a
3 px ring at 20%; a row inside something that scrolls draws it inside its edge
(-2 px) so the scroll does not clip it. Nothing that takes the focus is left
without a ring.

## Controls

The reference is KOS for Mac's `Controls.swift`; the extension's `kos.css`
and the dashboard's `styles.css` draw the same things.

- **Button.** Two heights: `--control-h` (36) and, for a small one in a
  row or a bar, `--control-h-sm` (30); nothing else. The same action is the
  same kind everywhere: Run now and Set rates are secondary, Delete forever
  and Empty trash danger, Cancel secondary, the one action a sheet is for
  primary and last. Four kinds. Primary: `accent`, `accent-lit` under the pointer,
  `on-accent` words. Secondary: `panel-2` with a `line` border; under the
  pointer the border goes `line-strong`. Ghost: no fill, `muted` words,
  `panel-2` under the pointer. Danger: `danger` words on a 10% fill with a 25%
  border, 17% and 45% under the pointer. Pressed, any button scales to 0.97;
  disabled, it is at 45% opacity. Approve is a primary button, not a green
  one: green says how something went, not what to press.
- **Icon button.** A 26 px circle holding one symbol, `muted`, `panel-2` and
  a `line` border under the pointer.
- **Switch.** A 34 by 20 capsule with a 14 px knob. Off is `line-strong`
  (`faint` under the pointer), on is `accent` (`accent-lit`) with an
  `on-accent` knob. Not a checkbox with an On/Off label beside it.
- **Chips.** One choice of a few. Radius 7, `panel-2`, `muted` words; the
  chosen one is `accent` words at 600 on a dim accent tint with an edge
  border. One chip style for every such choice: tabs over a list, a mode, a
  kind filter, a source to browse; the kit's `Chips`, `round` inside
  something round (the landing's box), as Shape says.
- **Pill.** A state in a word: 11 / 500 in its tone on a dim tint, a 6 px dot
  before the word, no border. The word and the tone are `STATE_WORDS`'s
  (`@kos/shared`), drawn by the kit's `StatusPill`: Done, Failed, Running,
  Needs you, On, Off, Quiet and the rest, in sentence case. A quiet or off
  thing is never green; a switch that sets a state stands alone, with no
  pill beside it saying the same.
- **Field.** A `bg` well, `line` border, radius 7; its label above it at 12
  / 600 `muted` (the kit's `Field`), the same in Settings as in a sheet. A
  sample of what goes in ("sk-...") is the box's placeholder, not its hint.
  A setting that is on or off is a row: its words at the left, the switch at
  the right (`FieldRow`), never a switch under its label or a tick.
- **Sheet.** A drawer and a dialog share one head and one foot (the kit's
  `SheetHead`, `SheetFoot`): the title with a line under it and an × to
  close; the foot right-aligned, Cancel a secondary button, the one thing the
  sheet is for last in the accent ("Create" for something new, "Save" for a
  change, or the action's own word: Move, Ask KOS). Something that destroys
  sits apart at the far left. A confirm is Cancel, then what it confirms,
  last, in danger.
- **Empty.** A list with nothing in it says so (the kit's `EmptyState`): a
  dashed box with a title on a page, one quiet line in a card or a rail, a
  row across a table. A search or filter that finds nothing says "No <things>
  match these words and filters." and offers one Clear filters, on every
  page. Something asked for that is not there says "No <kind> called
  “<name>”" with the way back (`NotFound`), never the server's words.
- **Search.** One box (`SearchField`): the glass at its start, an × once it
  has words, "Search <what>" as its placeholder, in the page head's search
  slot on a list page, in the bar on Files.
- **Group and table heads.** A group of rows is headed at the title's size,
  600, with its count (`GroupHead`); a table's columns are named small, 600,
  in capitals, `faint` (`TableHead`), the Files list's too.
- **Link.** Words in the accent, underlined under the pointer (`.link`); a
  name in a row of facts may be `.link--quiet`, `muted` until the pointer is
  on it. A time is words, never a link. KOS's prose keeps its underline (Chat).
- **Card.** `panel`, `line` border, radius 10. A card that opens something
  shows it under the pointer; a card that does not, does not.
- **Row with a tile.** A 32 px tile (radius 7) tinted in the row's tone, the
  name, a muted line under it, and a chevron that turns when it opens.
- **Menu.** `panel`, `line-strong` border, radius 10, 3 px padding, the
  floating shadow; rows radius 7, `panel-2` under the pointer, the current
  one on a dim accent tint.
- **File list.** Finder's: rows 28 (44 under a finger), a tap opening and
  a long press asking for the menu under a finger, zebra at 2.5%, 5%
  under the pointer, the chosen row the accent at 26% while the list has the
  keys and grey when it does not; a row being dragged at 45%. A name is one
  line, cut in the middle with its extension kept, the whole name its
  tooltip; never clipped. Columns after Name hide by rank as the list
  narrows (Kind, then Date, then Size) rather than crowd it. A path is cut
  from the left, the outer folders giving way first. The bar is one row at
  any width; narrow, by the Finder's own width and not the window's, its
  tools fold into one ⋯ menu.
- **Approval.** What waits on the owner says so in `warn` (a 45% edge); an
  ask to work in a tab or to read it is the accent. The face, the task in a
  quiet box, the choices as chips, Deny then Allow (on a phone too, one to a
  row, Deny on top), and a countdown bar the width of the card in `faint`.
  One size on every surface: the Inbox, Home's Inbox panel and a chat draw
  the same card, each with its own warn edge and its countdown. A URL on it
  wraps after a slash, never inside a name.

## Touch

A coarse pointer (a phone, a tablet) gets one set of rules, in the
dashboard's `touch.css`, loaded after its sheet; the sizes are `TOUCH` in
`design.ts`, declared as `--tap` (44) and `--tap-text` (16), in px since a
fingertip does not scale with the density setting.

- **Targets.** Nothing to press is under 44 square. Both button heights
  (`--control-h`, `--control-h-sm`) become `--tap`; an icon button is a 44
  circle; a row, a tab, a chip, a menu row and an option are at least 44
  high. A mark that would break its line grown keeps its look: a switch, a
  disclosure chevron and a link in a line are a 44 box themselves, drawn as
  before inside it (a clear border or padding, taken back by as much
  margin, so the line does not move); a bare ×, a head's All and a colour
  take a 44 area round them. An attachment's × is a small circle on its
  tile's corner, its 44 box over a corner of the picture, not half of it.
  A tap flashes nothing of the engine's own (`--tap-highlight`); the press
  is the answer.
- **Fields.** Every field's words are at least 16, or iOS zooms the page in
  on focus and leaves it there. The one `!important` in the sheets.
- **No hover.** What the pointer reveals is shown: a chat row's ⋯, a
  message's actions, a claim's Pin, Edit and Forget (Forget set apart). A
  setting's words are whole, not cut at two lines. Keyboard shortcuts (⌘K,
  a menu row's keys, the search's key help) are not offered; the search has
  a Cancel instead of Escape.
- **The keyboard on screen.** A sheet ends above it (`--kb-inset`, kept by
  `watchKeyboard` in `touch.ts`), and the field typed into is scrolled into
  sight as it comes up. A dialog whose point is a list (Move) does not open
  the keyboard over it. Typing into a chat, the bar at the top goes, its
  head keeps only its title, and the composer folds to one row: the field,
  then attach and Send (and the mode, where there is room); the model, the
  dictation and the memory meter are back when the keyboard goes. Return in
  the composer starts a new line, as in a phone's messages; the Send button
  sends. A field whose name is suggested opens with it selected, and Return
  in a one-field dialog does what its primary button does.
- **A short window.** Under 500 tall (a phone on its side, or upright with
  Android's keyboard up), one rule set in `touch.css`: the composer is one
  row with the keyboard down too; on its side the chat's head is one line
  (the list toggle and crumbs, the title, its actions) and goes while
  typing; a settings card's Save is at the card's foot rather than pinned
  across a form with 300 px to show itself in. The messages kept 32 to
  163 px of such a window; they keep most of it.
- **A phone's frame.** The bar at the top is under every sheet, drawer and
  panel, which bring their own ×; the menu drawer opens by a swipe in from
  the left edge (`watchEdgeSwipe`) and shuts by a swipe back to it, and
  holds Refresh as a row of its own (the pages update live, so there is no
  pull to refresh); notes come in under the bar, off what is pinned to the
  bottom; a page's tabs wrap to a second line; Settings picks its section
  from a list rather than a strip of fifteen; Back lands where you were on
  a page that reads its data again (`keepScroll`), and a reload with
  settings not yet saved asks first;
  a list table is a card of two lines (`stackOnPhone`), its title and
  actions over its facts, a time said with its column's name.

## Motion

- **One spring** for anything that moves into place: stiffness 420, damping
  38, mass 0.9 (`spring` in `@kos/shared`'s design tokens; SwiftUI
  `.interpolatingSpring(mass: 0.9, stiffness: 420, damping: 38)`).
- **One ease** for fades and small slides: 180 ms, cubic-bezier(0.32, 0.72,
  0, 1).
- Hover 140 ms ease-out; press 80 ms to 0.97 (`HOVER`, `PRESS` in design.ts,
  `--hover`, `--press`, `--press-scale` on the web). `kit.css` gives every
  control these and the one focus ring at no weight (`:where`), so a control
  with nothing of its own still answers; a row that spans its list answers
  with its fill and does not shrink.
- A page arrives there from its first frame: the one it replaces goes at
  once, the new one settles from a fade most of the way in and an 8 px rise
  (`pageArrive`), so a switch never shows an empty frame. An approval arrives
  and leaves with a fade and an 8 px rise (`rise`), the ones under it moving
  up at once.
- Content arrives with a fade and an 8 px rise; something that floats (a
  menu, a popover, a sheet) with a fade and a scale from 0.98.
- Nothing waits on an animation to finish; reduced motion turns them off:
  motion's own through `MotionConfig reducedMotion="user"` at each app's
  root, and every CSS animation and transition by one rule in `kit.css`.

## Words

The same thing is called the same thing on every surface: the dashboard,
Discord, the side panel, KOS for Mac, and in what KOS says.

| Word | What it is | How it is named where it speaks or asks |
| --- | --- | --- |
| KOS | the root, where work is routed from | KOS |
| orchestrator | a project's own thread, one per project, which plans the work and hands it out | "Garden orchestrator"; inside the project's own rail or channel, Orchestrator |
| agent | a chat inside a project, doing a piece of its work | its title ("Fix login"); "agent" is its kind, on the rail, in `/agents`, in counts |
| blob | a standing helper with a face and a thread of its own: "a helper that looks after one thing for you" | its name, never "agent"; its tools are offered in plain groups (Files and folders, The web, Memory, Schedules, Projects and tables, Messages and chats, Run code, Secrets, Your computer), the families under Advanced |
| build | coding work KOS runs in a folder | its folder; never "coding agent" |
| chat | anything else: a chat at the root, a surface's own stream | its title |
| schedule | what KOS runs on its own, on a timer | "Schedule" everywhere in the dashboard: the page, its tab, New schedule, the editor; never "cron" or "job" in words the owner reads. The cron line and an id are for a tooltip; the words are `scheduleWords` ("Weekdays at 8:00 AM"). The editor picks when (Every day, Weekdays, Some days, Every few hours, Every few minutes, Monthly) and writes the line; the line itself is "Advanced: write the line", checked as typed (`cronProblem`) |
| Inbox | the one queue of what waits on the owner | Inbox: the nav, Home's panel, the palette; "Approvals" only as the group of asks inside it |
| step | one thing KOS did along the way (read a file, fetch a page) | by what it did, from `toolWords` (`@kos/shared`): "List files", "Save a secret", with what it was done to after it (`stepLine`); never the tool's name ("files.ls"), an id or its arguments, which are for a tooltip and Details |
| memory's tabs | what KOS remembers, by what the owner looks for | What it knows, To decide, Notes, Everything said, Upkeep, Other apps; one remembered thing is a claim, its key said as words ("Home city") with the key its tooltip |
| when KOS asks for a secret | how often an owner's yes on a secret lasts | Every time, Once per request, Once per site |
| sites KOS may reach | the hosts KOS fetches from without asking | "Sites KOS may reach" in Settings, Network and Permissions, and in an ask ("example.com is not one of the sites KOS may reach"); never "allowed hosts" or "allowlist" |
| the model for thinking, the cheap model, the screen model | the three routes a turn's models go by | those words in Settings, Models, the composer's model chip and a schedule's Model; never "reasoning route" or "cheap route" |

Maintenance, where KOS repairs itself, is a project and goes by Maintenance.

KOS's own schedules each go by one name on every page: Memory: Read,
Memory: Tidy, Memory: Condense, Backup, Faces, Improve (`SYSTEM_SCHEDULES`
in `@kos/shared`). In a log or a list of who said what, KOS's replies are
KOS's and the owner's are You; "agent" is a project chat's kind, never
KOS's.

A kind as a tag is in sentence case, from one table (`KIND_WORDS`,
`kindWord`): Project, System, Orchestrator, Blob, Turn, Schedule, Tool, Doc,
Deck, Login, API key. A thing is named by its name, never its slug ("Plant
watcher", not plant-watcher; "Reading log", not reading_log); an id or a
slug is for a tooltip. Every trash says Restore, Delete forever and Empty
trash; a restore says so in a toast ("Restored “Old memo”"). A list of
projects is by name, KOS's own last; KOS's own schedules are grouped as
KOS's upkeep. Files hides KOS's own files (its database and profile) until
Show KOS's files.

A name the owner gives (a project, a schedule, a secret, a blob, an
artifact) is checked one way (`checkName` in `@kos/shared`), by the server
and by the form as it is typed: empty, longer than 80 characters (an
artifact's title 120), a line break, no letter or digit, or another's name
in any case, each said in one sentence on the field ("There is already a
project called “Home lab”. Pick another name."), with Create held while it
stands. Enter submits every form. An error is said in words (`errorWords`):
"There is no file or folder called “notes.md”", never a store's ("UNIQUE
constraint failed"), a tool's ("ENOENT") or a host's path; the raw text is
under Details. A list shows where its rows will be while it is read
(EmptyState's `loading`) and says it is empty only once it has been.

When something happened is said one way (`timeWords`): "just now", "5m
ago", "3h ago", "2d ago", "in 25m"; a clock time is `momentWords`'s ("Tomorrow
8:00 AM"). A schedule's next run is its clock time, its last run how long
ago or "Never run".
An approval says who asks by that name, on the dashboard, in #needs-you, in
the channel it was asked in and in a DM.

## The face

KOS is its face: the blob, alive (it breathes, looks, blinks) in every
window of its own. The bar the extension draws into a web page carries a
still of it, drawn in the page's own shadow root, the page being someone
else's. It leads a window's head (36 in the extension, 42 in
KOS for Mac, 22 beside the dashboard's wordmark), sits in the session bar
while KOS works, and in a consent sheet at 54 in a halo. On the dashboard
the brand is the face and the K-OS wordmark; everywhere else the name is
KOS.

A blob's outline grows from its name, or from a word it is given: a few
broad lumps, eased back until it bulges out all round (`shapeOf` in
`@kos/shared`). KOS keeps the plain gumdrop unless the owner gives it a
word under Settings, Appearance. KOS sends its face, as set there, to the
extension and KOS for Mac (the `face` frame, [computer.md](computer.md)), so
all three draw the same KOS; each draws a KOS by the face it sent, and the
default one for a KOS that has sent none.

## Chat

The dashboard's chats, the side panel and the KOS for Mac chat window are the
same conversation, drawn the same way, the dashboard's numbers on all three;
the window draws it natively, and shows LaTeX as written.

- **Type:** the words, the owner's and KOS's and the box's, at 15, line
  1.45; table cells 14; code blocks and table heads 13; chips, notes and
  the chat's name 12. KOS for Mac keeps them in `ChatType`.
- **Spacing:** 10 between messages, 16 at the column's sides, 8 between
  blocks of a reply; a list indents 19.
- **A long chat:** KOS rereads its newest messages (chat memory); what it
  lets go stays in the thread for the owner, above a line, and a full chat
  memory is a quiet meter, not a warning. The thread opens on its newest
  stretch, Show earlier at its top and Jump to latest at its foot.

- **The owner's message:** a bubble on the right, at most 88% of the
  column, padded 9 by 12, the accent at the strong tint over `panel-2`,
  radius 14 with its bottom right corner 4. Words in
  `text`, not on solid blue, read as the same markdown KOS's are, so a link
  pasted is a link and a formula is typeset. A long one folds to its first
  lines under a fade with Show more (`Fold`): at a desk past 12 lines or 800
  characters, showing 8; on a phone past 9 lines or 600, showing 6. Its
  files stay under it, and opening it is kept while the page is open.
- **KOS's reply:** prose on the page, no bubble.
- **Markdown:** headings at the words' size, set apart by weight, lists
  that nest (disc, circle, square; a, b under numbers), code spans at nine
  tenths of the words on `panel-2` at radius 4 (KOS for Mac gives them the
  tint alone), code blocks on `panel` with a line at radius 10, padded 10
  by 11, their language and Copy over them, a long one folded with Show
  all, links in the accent and underlined, quotes with a `line-strong`
  rule, LaTeX typeset, references as `violet` chips, tables with a `muted`
  head and a `line` under each row, words broken between words and never
  inside one, scrolling sideways when wider than the column. A grid without a head line stays as the text it is.
- **Steps:** a turn's tool calls are quiet rows under its words. The side
  panel and KOS for Mac fold them to one "N steps" chip, drawn as the
  composer's chips are, being narrow; the dashboard shows each as a row
  that opens to its arguments and result.
- **Composer:** one box, `panel`, radius 14, padded 7 (11 at its start),
  the field borderless inside it, the chips under it (model, mode, context,
  the app in front), and a 30 px round send button in the accent, `line`
  with a `faint` arrow when there is nothing to send. The whole box takes
  the focus ring. Its hint, in `faint`, is "Message <who>, / for commands,
  @ to name things", on one line, cut short when the box is narrow.
- **Chips:** 12, `muted` on a `panel-2` capsule with no edge, padded 3 by
  10, 24 high; the accent's tint when on. A long one is cut at its end,
  never in its middle, and in KOS for Mac the app in front keeps its room
  longest.

## Changing it

Change `design.ts` first, then the three declarations, then this page. The
test names the surface and the token that disagree.
