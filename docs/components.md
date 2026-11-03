# Components

Every piece the three apps are drawn with, and where each app keeps it:
the dashboard (packages/ui), KOS for Chrome (packages/browser-extension)
and KOS for Mac (packages/device-macos). The look of each is in
[design.md](design.md); this is where to find it.

**The rule.** Before drawing something, find it here and use it. If it is
not here, add it to the kit first (`packages/kit/src` for the two web apps,
`Controls.swift` for KOS for Mac), then to this table, then use it. A piece
drawn once in a page, by hand, is how the three apps came to disagree: five
label styles, three icon buttons, eleven hand-made switches.

The web kit is `@kos/kit`: its React components, and `kit.css`, which both
web apps load before their own sheet. KOS for Mac cannot share code with
them, so it keeps the same pieces under the same names in Swift.

## Tokens

| What | Shared source | Dashboard | KOS for Chrome | KOS for Mac |
| --- | --- | --- | --- | --- |
| Colours, corners, spring, shadow | `shared/src/design.ts` (`COLOURS`, `RADII`, `SPRING`, `FLOAT_SHADOW`) | `:root` in `ui/src/styles.css` | `:root` in `static/kos.css` | `Theme` in `Theme.swift` |
| Type scale | `TYPE` in `design.ts` (`--text-xs` to `--text-2xl`) | `--text-*` | `--text-*` | `KOSType` in `Theme.swift` (title 17, body 15, table 14, dense 13, control 12.5, detail 12, small 11.5, tiny 11, the label's size too); `Font.kos(_:_:)` sets one |
| Hover, press, tints | | 140 ms, 0.97, 14% | the same | `Theme.hover`, `Theme.press`, `Theme.tint`, `Theme.edge` |
| Hints and empty lines | | `--muted` at `--text-base` (`.hint`, `.empty-text`, `.empty-line`, `.set-hint`) | the same | `Theme.muted` |
| Motion presets | `kit/src/motion.ts` (`spring`, `ease`, `listItem`, `stagger`, `card`) | from the kit | from the kit | `Theme.spring` |

`design.test.ts` fails when the colours, corners, spring or shadow drift
in either stylesheet or in `Theme.swift` and `Palette.swift`, when the
two stylesheets' `--text-*` steps drift from `TYPE`, or when either
stylesheet stops declaring a token `kit.css` uses. It does not hold
`KOSType`, the motion presets or the hover, press and tint values; keep
those to this table by hand.

## Controls

| Component | What it is | Web | KOS for Chrome | KOS for Mac |
| --- | --- | --- | --- | --- |
| Icons | One set, one stroke (1.7), titled or bare | `kit/src/icons.tsx` (`CloseIcon`, `ChevronDown`, `SendIcon`, `ComposeIcon`, `ChatIcon`, `NavIcon`, ...) | the kit's | SF Symbols, named in the chat and window code |
| `Pill` | A state in a word: its tone, a dot | kit | kit | `Pill` (Controls) |
| `Tag` | A fact in a word or two on a bordered capsule; not a state; `remove` ends it in a small × | kit (memory kinds, tool families) | kit, with `remove` (a hidden site) | `Tag(_ text:, remove:, leading:)` (Controls), which draws `AppChip`, a hidden app |
| `Switch` | On or off | kit | kit | `KOSSwitch`, `SwitchRow` (Controls) |
| `Chips` | One choice of a few: filters, kinds, tabs over a list | kit (`small`, `label`, an option may carry a title) | kit | `KOSChoices` with `ChipStyle` (Controls) |
| `IconButton` | A round button holding one icon; `danger`, `bare` (no ring, for a dismiss in a row); `IconLink` is the same circle as a link | kit | kit (the popup's chat, gear and back, New chat, every ×) | `IconButton` (Controls); `bare: true` is `.icon-btn--bare` |
| `Card` | A boxed section: a small uppercase head (title, count, pill, action), then its body | kit | the `.card` class | `Card(picked:, lit:, padding:, spacing:)` (Controls), which also draws `TargetTile` and the code block |
| `Count` | How many, beside a title or a group's name: a small grey capsule, or in the card's tint where it has one; a total, never news | kit (cards, home panels, Inbox, Knowledge, Projects, the chats rail) | | |
| `Empty` | What a list says when it is empty: a dashed box, or one quiet line inside a card (`inline`) | kit (every list and panel, and the page widgets) | `.empty-state` (the side panel's centred face and words) | `EmptyChat` (`ChatView.swift`) |
| Label | The small uppercase head over a card, a section, a group | `.label` in `kit.css` | `.label` | `SectionLabel` (Controls) |
| `Section` | A label with an action at its right, over what it labels | kit (the dashboard's settings card is its own `Section` in `SettingsPage.tsx`) | kit | `KOSSection` (Controls) |
| `DrawerRow` | A row that opens what is under it (`.drawer-row`) | kit, not yet used | kit | `DrawerRow` (`DrawerRow.swift`) |
| `RefChip` | A link to one of the owner's things (a project, a page, a site, a chat), in its kind's mark and colour, as a reference in a message is | kit; the Markdown's references are drawn with it | kit (through Markdown) | the violet reference chips of `chatInline` (`ChatMarkdown.swift`) |
| `Collapse` | What a drawer opens to | kit, not yet used | kit | the `HomeView.inPlace` transition |
| `WorkingDots` | KOS at work before it has a step to show | kit | kit | `Thinking` (`ChatView.swift`) |
| `Face` | KOS's face, or a blob's; `KosLook`/`useKosLook` and `AgentFaces` give the looks, `lookOf`, `moodOf`, `faceLookOf`, `faceDataUrl` read them | kit | kit (`drawing`, as a KOS sends it) | `KOSFace` (`KOSFace.swift`) with `FaceLook` |
| `Field` | A label, the control, then a hint or an error; `badge`, `meta`; `Req` marks it required | kit; a setting in a list is `FieldRow` (`ui/src/kit.tsx`), whose words open on a click | kit (the popup's pairing); a setting row is `Setting`/`Toggle` in `popup.tsx` | `KOSField`, and `SwitchRow` for a setting (Controls) |
| `ConfirmButton` | A delete that asks once, beside itself | `ui/src/kit.tsx` | | |
| `Select` | A dropdown in KOS's look; Escape is its own | `ui/src/Select.tsx` (`popover.ts` places it) | the model chip's menu; a native `.kos-picker` for several KOS | SwiftUI `Menu` with `.chip()` |
| `Drawer`, `Modal` | A sheet from the right; a dialog | `ui/src/Drawer.tsx`, `ui/src/Modal.tsx` | | |
| `useDismiss` | Closes what floats on a press away, a scroll, a resize or Escape; a menu hears Escape first, a dialog last | kit; `useAnchoredPop` (`ui/src/kit.tsx`) for small popovers | kit (the side panel's chat switcher) | |
| `StatusDot` | A state as a dot alone: working, needs you, error, unread, read, on, off | kit; `ActivityDot` and `buildDot` (`ui/src/StatusDot.tsx`) choose it for a thread and a build | kit (the session's head) | `Dot` (Controls) |
| Page head | A page's title, its line, search and actions | `PageHead.tsx` | | |
| Link | Words in the accent that go somewhere | `a` in `styles.css` | `a` | `KOSLink` (Controls); `.pointingHand()` for the cursor |
| Time words | Minutes as a person says them | `SchedulePicker.tsx` and `schedulewords.ts` for schedules | `minutesWords` (`pages.ts`) | `minutesWords` (Controls) |
| Buttons | primary, ghost, danger, small | `.btn` classes | `.btn` classes | `KOSButtonStyle` (Controls); `round: 30` is the round send |
| Row words | A row's title over its line of detail, one line each; `.line-text--wrap` lets a setting's detail run on | `.line-text` (kit) | `.line-text` (the tab card), `.line-text--wrap` (the popup's settings) | `RowText` (Controls) |
| Tile | A symbol on its tone's tint | `.tile` (kit) | `.tile` | `Tile` (Controls) |
| Capsule chip | The steps of a turn, the model, the mode | `.composer-engine` | `.steps-head`, `.model`, `.mode`: one rule | `Chip` and `.chip()` (Controls); `opens:` adds the chevron (the steps chip, the model menu) |
| Hairline, MenuRow | Small pieces | | | `Hairline`, `MenuRow` (Controls) |

## The chat

The dashboard's chat is the reference; the two narrow surfaces fold its
tool rows to one chip.

| Piece | Dashboard | KOS for Chrome side panel | KOS for Mac chat window |
| --- | --- | --- | --- |
| KOS's words | kit `Markdown`; `MentionNames` names references, `RefLinks` (given by `ui/src/refs.tsx`) routes them, `KindMark` marks their kind, `Tex` sets maths | kit `Markdown` (references as plain chips) | `ChatMarkdown` and `chatInline` (`ChatMarkdown.swift`) |
| The owner's bubble | `.bubble--you` in `ChatsPage.tsx` | `.msg--you` in `panel.tsx` | `Bubble` (`ChatView.swift`) |
| Steps | `ToolCall.tsx`, a row per call | `Steps` in `panel.tsx`, one chip | `Steps` (`ChatView.swift`), one `Chip(..., opens:)` |
| Live turn | `LiveTurn.tsx` with `WorkingDots` | `Story` and `WorkingDots` in `panel.tsx` | `Thinking`, live `Steps` |
| Composer | `.composer-box` in `ChatsPage.tsx`, `HighlightedInput.tsx`, `Autocomplete.tsx` | `Composer` in `panel.tsx` | the composer in `ChatView.swift` |
| Model and mode chips | `ModelPicker.tsx`, `.composer-engine` | `ModelChoice`, `AutoChoice` in `panel.tsx`, on the one capsule rule | `Chip(..., opens:)` menus in `ChatView.swift` |
| Send | `.send` with kit `SendIcon`, Stop while a turn runs | `.send` with kit `SendIcon` | `KOSButtonStyle(..., round: 30)` with `arrow.right` (Controls) |
| Approval | `Decision.tsx` (Approve, Always, Deny) | `AskCard` in `panel.tsx` | `AskCard` (`ChatView.swift`) |
| What the chat is beside | | `TabBar` in `panel.tsx` (the tab, a status pill) | `AppCard` (`ChatView.swift`, the app in front) |
| Chat switcher | the chats rail | `ChatSwitcher` in `panel.tsx` | `Switcher` (`ChatView.swift`) |
| Message actions | `MessageActions.tsx` (kit `IconButton`s) | | |
| A quoted selection | | `.quote-chip` in `panel.tsx`, its × a bare kit `IconButton` | |

## Names the two web apps no longer share

The two web stylesheets never load on one page, but one class meaning two
things made the code hard to read. The dashboard kept its names:

| Class | Means | KOS for Chrome's own, renamed |
| --- | --- | --- |
| `.card` | the kit's `Card` | (takes the kit's) |
| `.empty` | the kit's dashed `Empty` | `.empty-state` |
| `.hint` | the kit's hint line | (takes the kit's) |
| `.live`, `.live-head` | the dashboard's live turn | `.card--live`, `.session-head` |
| `.panel-head` | a home panel's head | `.chat-head` |
| `.drawer` | the dashboard's sheet | `.drawer-row`, now the kit's `DrawerRow` |
| `.thinking` | the dashboard's kept reasoning | `.working` |
