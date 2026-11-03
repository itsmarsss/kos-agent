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
markdown KOS speaks in, one set of icons, Pill, Switch, Chips, IconButton,
the working dots, Section, Collapse and DrawerRow, with their motion, and
`kit.css`, which each app loads before its own sheet. A surface says only
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

One dark palette, the same hexes on all three.

| Token | Value | For |
| --- | --- | --- |
| `bg` | #0c0e12 | the window, a field's well |
| `panel` | #12151c | cards, the composer, menus |
| `panel-2` | #181c26 | a control at rest, a row under the pointer |
| `line` | #262b36 | borders |
| `line-strong` | #3a4150 | a border under the pointer, a switch that is off |
| `text` | #e7ebf3 | words |
| `muted` | #8b93a7 | secondary words, a quiet control |
| `faint` | #5c6578 | labels, placeholders, times |
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

Light: the dashboard also has a light palette (Settings, Appearance). The
extension and KOS for Mac are dark only, as KOS for Mac always was. Light's
ok and warn are darker (#0f6e45, #7d5400) so a pill's text on its own tint
still reads at 4.5:1.

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
| heading (a sheet's) | 17, 600 |
| page heading | 22, 600, -0.02em |

Weights are 400, 500, 600 and 700, nothing between.

The dashboard is a full window read at arm's length, so its body sits one
step up the ladder (`--text-md`, 14 at the default density) and its density
setting scales the whole ladder. The roles and their order are the same.
Both web surfaces declare the dashboard's steps as `--text-xs` to
`--text-2xl` (`TYPE` in design.ts), which the kit's pieces are set in.

## Shape

Radii: 4 (code, a keycap), 7 (a control: button, field, chip, menu row),
10 (a card, a menu, a popover), 14 (a sheet, the composer, a message
bubble), and the capsule (pill, switch, a button inside something round).
Corners are continuous on the Mac.

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
one shadow, `0 12px 32px rgba(0,0,0,0.45)`, and a `line-strong` border. Focus
is a 2 px accent outline 1 px out, or on a field its border turns accent with a
3 px ring at 20%.

## Controls

The reference is KOS for Mac's `Controls.swift`; the extension's `kos.css`
and the dashboard's `styles.css` draw the same things.

- **Button.** Four kinds. Primary: `accent`, `accent-lit` under the pointer,
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
  kind filter.
- **Pill.** A state in a word: 11 / 500 in its tone on a dim tint, a 6 px dot
  before the word, no border.
- **Field.** A `bg` well, `line` border, radius 7; its label above it at 11.5
  / 500 `muted`.
- **Card.** `panel`, `line` border, radius 10. A card that opens something
  shows it under the pointer; a card that does not, does not.
- **Row with a tile.** A 32 px tile (radius 7) tinted in the row's tone, the
  name, a muted line under it, and a chevron that turns when it opens.
- **Menu.** `panel`, `line-strong` border, radius 10, 3 px padding, the
  floating shadow; rows radius 7, `panel-2` under the pointer, the current
  one on a dim accent tint.
- **Approval.** What waits on the owner says so in `warn` (a 45% edge); an
  ask to work in a tab or to read it is the accent. The face, the task in a
  quiet box, the choices as chips, Deny then Allow, and a countdown bar the
  width of the card in `faint`.

## Motion

- **One spring** for anything that moves into place: stiffness 420, damping
  38, mass 0.9 (`spring` in `@kos/shared`'s design tokens; SwiftUI
  `.interpolatingSpring(mass: 0.9, stiffness: 420, damping: 38)`).
- **One ease** for fades and small slides: 180 ms, cubic-bezier(0.32, 0.72,
  0, 1).
- Hover 140 ms ease-out; press 80 ms to 0.97.
- Content arrives with a fade and an 8 px rise; something that floats (a
  menu, a popover, a sheet) with a fade and a scale from 0.98.
- Nothing waits on an animation to finish; reduced motion turns them off.

## Words

The same thing is called the same thing on every surface: the dashboard,
Discord, the side panel, KOS for Mac, and in what KOS says.

| Word | What it is | How it is named where it speaks or asks |
| --- | --- | --- |
| KOS | the root, where work is routed from | KOS |
| orchestrator | a project's own thread, one per project, which plans the work and hands it out | "Garden orchestrator"; inside the project's own rail or channel, Orchestrator |
| agent | a chat inside a project, doing a piece of its work | its title ("Fix login"); "agent" is its kind, on the rail, in `/agents`, in counts |
| blob | a standing helper with a face and a thread of its own | its name, never "agent" |
| build | coding work KOS runs in a folder | its folder; never "coding agent" |
| chat | anything else: a chat at the root, a surface's own stream | its title |

Maintenance, where KOS repairs itself, is a project and goes by Maintenance.
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

- **The owner's message:** a bubble on the right, at most 88% of the
  column, padded 9 by 12, the accent at the strong tint over `panel-2`,
  radius 14 with its bottom right corner 4. Words in
  `text`, not on solid blue, read as the same markdown KOS's are, so a link
  pasted is a link and a formula is typeset.
- **KOS's reply:** prose on the page, no bubble.
- **Markdown:** headings at the words' size, set apart by weight, lists
  that nest (disc, circle, square; a, b under numbers), code spans at nine
  tenths of the words on `panel-2` at radius 4 (KOS for Mac gives them the
  tint alone), code blocks on `panel` with a line at radius 10, padded 10
  by 11, links in the accent and underlined, quotes with a `line-strong`
  rule, LaTeX typeset, references as `violet` chips, tables with a `muted`
  head and a `line` under each row, scrolling sideways when wider than the
  column. A grid without a head line stays as the text it is.
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
