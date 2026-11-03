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
| Type scale | `TYPE` in `design.ts` (`--text-xs` to `--text-2xl`) | `--text-*` | `--text-*` | `KOSType` in `Theme.swift` (title 17, body 15, table 14, dense 13, control 12.5, detail 12, small 11.5, tiny 11, label 10.5) |
| Hover, press, tints | | 140 ms, 0.97, 14% | the same | `Theme.hover`, `Theme.press`, `Theme.tint`, `Theme.edge` |
| Motion presets | `kit/src/motion.ts` (`spring`, `ease`, `listItem`, `stagger`, `card`) | from the kit | from the kit | `Theme.spring` |

`design.test.ts` fails when any of the declarations drifts from
`design.ts`.

## Controls

| Component | What it is | Web | KOS for Chrome | KOS for Mac |
| --- | --- | --- | --- | --- |
| Icons | One set, one stroke (1.7), titled or bare | `kit/src/icons.tsx` (`CloseIcon`, `ChevronDown`, `SendIcon`, `ComposeIcon`, `ChatIcon`, `NavIcon`, ...) | the kit's | SF Symbols, named in the chat and window code |
| `Pill` | A state in a word: its tone, a dot | kit | kit | `Pill` (Controls) |
| `Tag` | A fact in a word or two on a bordered capsule; not a state | kit | kit | |
| `Switch` | On or off | kit | kit | `KOSSwitch`, `SwitchRow` (Controls) |
| `Chips` | One choice of a few: filters, kinds, tabs over a list | kit (`small`, `label`, an option may carry a title) | kit | `KOSChoices` with `ChipStyle` (Controls) |
| `IconButton` | A round button holding one icon; `danger`, `bare` | kit | kit | `IconButton` (Controls) |
| `Card` | A boxed section: a small uppercase head (title, count, pill, action), then its body | kit | the `.card` class | `Card` (Controls) |
| `Empty` | What a list says when it is empty: a dashed box, or one quiet line inside a card (`inline`) | kit | `.empty-state` (the side panel's centred face and words) | `EmptyChat` (`ChatView.swift`) |
| Label | The small uppercase head over a card, a section, a group | `.label` in `kit.css` | `.label` | `SectionLabel` (Controls) |
| `Section` | A label with an action at its right, over what it labels | kit | kit | `KOSSection` (Controls) |
| `DrawerRow` | A row that opens what is under it | kit | kit | `DrawerRow` (`DrawerRow.swift`) |
| `Collapse` | What a drawer opens to | kit | kit | the `HomeView.inPlace` transition |
| `WorkingDots` | KOS at work before it has a step to show | kit | kit | `Thinking` (`ChatView.swift`) |
| `Face` | KOS's face, or a blob's | kit (`Face`, `faceSvg`) | kit | `KOSFace` (`KOSFace.swift`) |
| `Field` | A label, the control, a hint or an error; `badge`, `meta`, and `row` for a list of settings | `ui/src/kit.tsx` | `.field` | `KOSField` (Controls) |
| `ConfirmButton` | A delete that asks once, beside itself | `ui/src/kit.tsx` | | |
| `Select` | A dropdown in KOS's look | `ui/src/Select.tsx` | the model chip's menu | SwiftUI `Menu` with `.chip()` |
| `Drawer`, `Modal` | A sheet from the right; a dialog | `ui/src/Drawer.tsx`, `ui/src/Modal.tsx` | | |
| `useDismiss` | Closes what floats on a press away, a scroll, a resize or Escape | `ui/src/useDismiss.ts` | | |
| Buttons | primary, ghost, danger, small | `.btn` classes | `.btn` classes | `KOSButtonStyle` (Controls) |
| Row words | A row's title over its line of detail | `.line-text` (kit) | `.line-text` | `RowText` (Controls) |
| Tile | A symbol on its tone's tint | `.tile` (kit) | `.tile` | `Tile` (Controls) |
| Dot, Hairline, MenuRow, Chip | Small pieces | | | `Dot`, `Hairline`, `MenuRow`, `Chip` and `.chip()` (Controls) |

## The chat

The dashboard's chat is the reference; the two narrow surfaces fold its
tool rows to one chip.

| Piece | Dashboard | KOS for Chrome side panel | KOS for Mac chat window |
| --- | --- | --- | --- |
| KOS's words | kit `Markdown` (references routed by `ui/src/refs.tsx`) | kit `Markdown` (references as plain chips) | `ChatMarkdown` and `chatInline` (`ChatMarkdown.swift`) |
| The owner's bubble | `.bubble--you` in `ChatsPage.tsx` | `.msg--you` in `panel.tsx` | `Bubble` (`ChatView.swift`) |
| Steps | `ToolCall.tsx`, a row per call | `Steps` in `panel.tsx`, one chip | `Steps` (`ChatView.swift`), one chip |
| Live turn | `LiveTurn.tsx` with `WorkingDots` | `Story` and `WorkingDots` in `panel.tsx` | `Thinking`, live `Steps` |
| Composer | `.composer-box` in `ChatsPage.tsx`, `HighlightedInput.tsx`, `Autocomplete.tsx` | `Composer` in `panel.tsx` | the composer in `ChatView.swift` |
| Model and mode chips | `ModelPicker.tsx`, `.composer-engine` | `ModelChoice`, `AutoChoice` in `panel.tsx` | `.chip()` menus in `ChatView.swift` |
| Send | `.send` with kit `SendIcon`, Stop while a turn runs | `.send` with kit `SendIcon` | `SendStyle` (`ChatView.swift`, `arrow.right`) |
| Approval | `Decision.tsx` (Approve, Always, Deny) | `AskCard` in `panel.tsx` | `AskCard` (`ChatView.swift`) |
| What the chat is beside | | `TabBar` in `panel.tsx` (the tab, a status pill) | `AppCard` (`ChatView.swift`, the app in front) |
| Chat switcher | the chats rail | `ChatSwitcher` in `panel.tsx` | `Switcher` (`ChatView.swift`) |
| Message actions | `MessageActions.tsx` (kit `IconButton`s) | | |

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
| `.drawer` | the dashboard's sheet | `.drawer-row` |
| `.thinking` | the dashboard's kept reasoning | `.working` |
