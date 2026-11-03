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
| Motion presets | `kit/src/motion.ts` (`spring`, `ease`, `listItem`, `stagger`, `card`) | from the kit | from the kit | `Theme.spring` |

`design.test.ts` fails when the colours, corners, spring or shadow drift
in either stylesheet or in `Theme.swift` and `Palette.swift`, or when the
two stylesheets' `--text-*` steps drift from `TYPE`. It does not hold
`KOSType`, the motion presets or the hover, press and tint values; keep
those to this table by hand.

## Controls

| Component | What it is | Web | KOS for Chrome | KOS for Mac |
| --- | --- | --- | --- | --- |
| Icons | One set, one stroke (1.7), titled or bare | `kit/src/icons.tsx` (`CloseIcon`, `ChevronDown`, `SendIcon`, `ComposeIcon`, `ChatIcon`, `NavIcon`, ...) | the kit's | SF Symbols, named in the chat and window code |
| `Pill` | A state in a word: its tone, a dot | kit | kit | `Pill` (Controls) |
| `Tag` | A fact in a word or two on a bordered capsule; not a state | kit | its own `.site-chip` (a hidden site, with a remove ×) | `AppChip` (`AppPicker.swift`, a hidden app) |
| `Switch` | On or off | kit | kit | `KOSSwitch`, `SwitchRow` (Controls) |
| `Chips` | One choice of a few: filters, kinds, tabs over a list | kit (`small`, `label`, an option may carry a title) | kit | `KOSChoices` with `ChipStyle` (Controls) |
| `IconButton` | A round button holding one icon; `danger`, `bare` | kit | the kit's `.icon-btn` class on plain buttons | `IconButton` (Controls) |
| `Card` | A boxed section: a small uppercase head (title, count, pill, action), then its body | kit | the `.card` class | `Card` (Controls) |
| `Empty` | What a list says when it is empty: a dashed box, or one quiet line inside a card (`inline`) | kit | `.empty-state` (the side panel's centred face and words) | `EmptyChat` (`ChatView.swift`) |
| Label | The small uppercase head over a card, a section, a group | `.label` in `kit.css` | `.label` | `SectionLabel` (Controls) |
| `Section` | A label with an action at its right, over what it labels | kit (the dashboard's settings card is its own `Section` in `SettingsPage.tsx`) | kit | `KOSSection` (Controls) |
| `DrawerRow` | A row that opens what is under it (`.drawer-row`) | kit, not yet used | kit | `DrawerRow` (`DrawerRow.swift`) |
| `Collapse` | What a drawer opens to | kit, not yet used | kit | the `HomeView.inPlace` transition |
| `WorkingDots` | KOS at work before it has a step to show | kit | kit | `Thinking` (`ChatView.swift`) |
| `Face` | KOS's face, or a blob's; `KosLook`/`useKosLook` and `AgentFaces` give the looks, `lookOf`, `moodOf`, `faceLookOf`, `faceDataUrl` read them | kit | kit (`drawing`, as a KOS sends it) | `KOSFace` (`KOSFace.swift`) with `FaceLook` |
| `Field` | A label, the control, a hint or an error; `badge`, `meta`, and `row` for a list of settings; `Req` marks it required | `ui/src/kit.tsx` | its own `.field`; a setting row is `Setting`/`Toggle` in `popup.tsx` | `KOSField`, and `SwitchRow` for a setting (Controls) |
| `ConfirmButton` | A delete that asks once, beside itself | `ui/src/kit.tsx` | | |
| `Select` | A dropdown in KOS's look; Escape is its own | `ui/src/Select.tsx` (`popover.ts` places it) | the model chip's menu; a native `.kos-picker` for several KOS | SwiftUI `Menu` with `.chip()` |
| `Drawer`, `Modal` | A sheet from the right; a dialog | `ui/src/Drawer.tsx`, `ui/src/Modal.tsx` | | |
| `useDismiss` | Closes what floats on a press away, a scroll, a resize or Escape | `ui/src/useDismiss.ts`; `useAnchoredPop` (`ui/src/kit.tsx`) for small popovers | the side panel's switcher has its own | |
| Status dot | A state as a dot alone | `StatusDot.tsx` (`StatusDot`, `ActivityDot`) | `.session-head` draws its own | `Dot` (Controls) |
| Page head | A page's title, its line, search and actions | `PageHead.tsx` | | |
| Link | Words in the accent that go somewhere | `a` in `styles.css` | `a` | `KOSLink` (Controls); `.pointingHand()` for the cursor |
| Time words | Minutes as a person says them | `SchedulePicker.tsx` and `schedulewords.ts` for schedules | `minutesWords` (`pages.ts`) | `minutesWords` (Controls) |
| Buttons | primary, ghost, danger, small | `.btn` classes | `.btn` classes | `KOSButtonStyle` (Controls) |
| Row words | A row's title over its line of detail | `.line-text` (kit) | `.line-text` | `RowText` (Controls) |
| Tile | A symbol on its tone's tint | `.tile` (kit) | `.tile` | `Tile` (Controls) |
| Dot, Hairline, MenuRow, Chip | Small pieces | | | `Dot`, `Hairline`, `MenuRow`, `Chip` and `.chip()` (Controls) |

## The chat

The dashboard's chat is the reference; the two narrow surfaces fold its
tool rows to one chip.

| Piece | Dashboard | KOS for Chrome side panel | KOS for Mac chat window |
| --- | --- | --- | --- |
| KOS's words | kit `Markdown`; `MentionNames` names references, `RefLinks` (given by `ui/src/refs.tsx`) routes them, `KindMark` marks their kind, `Tex` sets maths | kit `Markdown` (references as plain chips) | `ChatMarkdown` and `chatInline` (`ChatMarkdown.swift`) |
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
| `.drawer` | the dashboard's sheet | `.drawer-row`, now the kit's `DrawerRow` |
| `.thinking` | the dashboard's kept reasoning | `.working` |
