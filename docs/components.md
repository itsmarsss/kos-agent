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
| `Chips` | One choice of a few: filters, kinds, tabs over a list | kit (`small`, `label`, `scroll` for one row that scrolls sideways on its own, an option may carry a title and a `Count` in its label) | kit | `KOSChoices` with `ChipStyle` (Controls) |
| `IconButton` | A round button holding one icon; `danger`, `bare` (no ring, for a dismiss in a row); `IconLink` is the same circle as a link | kit | kit (the popup's chat, gear and back, New chat, every ×) | `IconButton` (Controls); `bare: true` is `.icon-btn--bare` |
| `Card` | A boxed section: a small uppercase head (title, count, pill, action), then its body | kit | the `.card` class | `Card(picked:, lit:, padding:, spacing:)` (Controls), which also draws `TargetTile` and the code block |
| `Count` | How many, beside a title or a group's name: a small grey capsule, or in the card's tint where it has one; a total, never news | kit (cards, home panels, Inbox, Knowledge, Projects, the chats rail) | | |
| `Skeleton` | Where something will be while it loads: a quiet block in its shape, a slow sheen, none under reduced motion | kit (the Artifacts gallery's cards, the viewer) | | |
| `Empty` | What a list says when it is empty: a dashed box, or one quiet line inside a card (`inline`) | kit (every list and panel, and the page widgets) | `.empty-state` (the side panel's centred face and words) | `EmptyChat` (`ChatView.swift`) |
| Label | The small uppercase head over a card, a section, a group | `.label` in `kit.css` | `.label` | `SectionLabel` (Controls) |
| `Section` | A label with an action at its right, over what it labels | kit (the dashboard's settings card is its own `Section` in `SettingsPage.tsx`) | kit | `KOSSection` (Controls) |
| `DrawerRow` | A row that opens what is under it (`.drawer-row`) | kit, not yet used | kit | `DrawerRow` (`DrawerRow.swift`) |
| `RefChip` | A link to one of the owner's things (a project, a page, a site, a chat), in its kind's mark and colour, as a reference in a message is | kit; the Markdown's references are drawn with it | kit (through Markdown) | the violet reference chips of `chatInline` (`ChatMarkdown.swift`) |
| `Collapse` | What a drawer opens to | kit, not yet used | kit | the `HomeView.inPlace` transition |
| `WorkingDots` | KOS at work: the foot of a running turn, under whatever it showed last, until the turn ends | kit | kit | `Working` (`ChatView.swift`) |
| `Elapsed` | How long a turn has run, ticking: `formatElapsed` says it (45s, 3m 20s, 1h 4m) | kit | kit | `elapsedWords` (Controls) |
| `Countdown` | How long an ask has before it lapses, ticking ("lapses in 42s"), in the warning tone for its last 15 s | kit | kit (`AskCard`, `ConsentCard`) | |
| `QuoteLine` | What the owner quoted with a message, at the top of their bubble, where it came from on hover | kit (the thread's bubble) | kit (`.msg--you`) | |
| `Face` | KOS's face, or a blob's; `KosLook`/`useKosLook` and `AgentFaces` give the looks, `lookOf`, `moodOf`, `faceLookOf`, `faceDataUrl` read them | kit | kit (`drawing`, as a KOS sends it) | `KOSFace` (`KOSFace.swift`) with `FaceLook` |
| `Field` | A label, the control, then a hint or an error; `badge`, `meta`; `Req` marks it required | kit; a setting in a list is `FieldRow` (`ui/src/kit.tsx`), whose words open on a click | kit (the popup's pairing); a setting row is `Setting`/`Toggle` in `popup.tsx` | `KOSField`, and `SwitchRow` for a setting (Controls) |
| `ConfirmButton` | A delete that asks once, beside itself | `ui/src/kit.tsx` | | |
| `Select` | A dropdown in KOS's look, an option with a mark before it (a project's tile, a blob's face); Escape is its own | `ui/src/Select.tsx` (`popover.ts` places it) | the model chip's menu; a native `.kos-picker` for several KOS | SwiftUI `Menu` with `.chip()` |
| `Drawer`, `Modal` | A sheet from the right; a dialog | `ui/src/Drawer.tsx`, `ui/src/Modal.tsx` | | |
| `useDismiss` | Closes what floats on a press away, a scroll, a resize or Escape; a menu hears Escape first, a dialog last | kit; `useAnchoredPop` (`ui/src/kit.tsx`) for small popovers | kit (the side panel's chat switcher) | |
| `OverlayScroll` | The scrollbar as the Mac draws its own: no lane, a thin thumb over the edge, beside the element so its menus stack above it, that shows on scroll, hover or near the edge and fades after 800 ms, takes a press only with the pointer on it, draggable, its length and place following the content (`ResizeObserver`); wheel, keys and touch stay native, the thumb is `aria-hidden`. `overlayScroll(el)` lays it on any element (the document's root for a page that scrolls as a whole), `useOverlayScroll(ref?)` is the same as a ref; elsewhere `scrollbars.css` draws a thin bar that shows on hover. Never inside an artifact's frame, whose scrolling is the page's | kit (the page, the chat thread, the chats rail, the inline artifact, the settings rail and pane) | kit (the popup, the side panel's thread) | the system's own |
| `Tooltip` | A small card over what it explains, its arrow on it: at once on hover or when focus lands on it (no tab stop of its own; inside a link, on the link's focus), a tap toggles it, a press away or Escape closes it, passing Escape on; it follows a scroll and closes when its element leaves the window; one open at a time; above, below near the top, inside the window side to side; `role="tooltip"` and `aria-describedby` wired | kit (`.kos-tip`, drawn at the body); the Markdown's time chip is its first use | kit (through Markdown) | `.help` |
| Time chip | `<t:...:R>` on the reader's clock on a grey chip; its card says the date in full over the time, led by the locale's own joiner ("at", "à", "um"), in the reader's locale (`timeCard` in `shared/src/time.ts`) | kit `Markdown` (`.md-time`, `Tooltip`) | kit (through Markdown) | `ChatTime` (`ChatTime.swift`) in `chatInline`, the card as the line's `.help` |
| `StepPicture` | What a step saw (a tab, a screen): small under the step, larger on a press, smaller on another; every surface shows a step's picture with it, never one of a hidden site | kit (`.step-picture`; a tool card's frame, the live turn's) | kit (under a turn's steps chip, `.step-pictures`, live and in the chat) | `StepPicture` (Controls), in `FlowPictures` under `Steps` (`ChatView.swift`) |
| `StatusDot` | A state as a dot alone: working, needs you, error, unread, read, on, off | kit; `ActivityDot` and `buildDot` (`ui/src/StatusDot.tsx`) choose it for a thread and a build | kit (the session's head) | `Dot` (Controls) |
| Page head | A page's title (with a `Count` when given one), its line, search and actions | `PageHead.tsx` | | |
| Artifact frame | An artifact the agent wrote (page, doc, deck or sheet), in its sandboxed frame, with `window.kos`, its kind's runtime and fonts, and the version history; drawn as part of the page: a page or a doc as tall as its content, a deck a 16:9 stage, a sheet the view's height | `widgets/ArtifactPage.tsx` (the frame; `ArtifactHandle.present()`), `widgets/frameheight.ts` (the height it takes, the jumps it scrolls to), `@kos/shared` `artifactdoc.ts` (its documents), `PageHistory.tsx` (`PageHistory` a row, `VersionList` a drawer's list with Preview and Restore), `pagelib/docedit.ts` (a doc's editor); its look is `@kos/kit/page.css` with `kit.css`, and the kinds' runtimes in `ui/pagelib` ([artifacts.md](artifacts.md)) | | |
| Artifact card | One artifact in the gallery: its 16:10 capture or its kind's mark, title, a line of description, kind `Tag`, the project's `ProjectMark` and name, and time | `ArtifactCard` (`.artifact-card`) in `ArtifactsPage.tsx` | | |
| Artifact rail | What a project or a blob owns, beside its chat: kind tile, title, time; one folding row on a narrow window | `ArtifactRail`, `ArtifactStrip` (`ArtifactRail.tsx`), in `ProjectPanel` and `AgentPanel` | | |
| Artifact viewer | One artifact full size, in the Artifacts page, a project's page and in place of a project's chat: a head with its kind, project and time, then History (a `Drawer` with `VersionList`), Open in project, Present for a deck, Edit with KOS | `ArtifactViewer` in `ArtifactsPage.tsx` | | |
| Kind marks | page, doc, deck and sheet, and the Artifacts nav entry | kit `NavIcon` (`page`, `doc`, `deck`, `sheet`, `artifacts`) | | |
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
| Live turn | `LiveTurn.tsx`, its foot `WorkingDots` and `Elapsed` | `Story`, its foot `Working` in `panel.tsx` | live `Steps`, its foot `Working` |
| Composer | `.composer-box` in `ChatsPage.tsx`, `HighlightedInput.tsx`, `Autocomplete.tsx` | `Composer` in `panel.tsx` | the composer in `ChatView.swift` |
| Model and mode chips | `ModelPicker.tsx`, `.composer-engine` | `ModelChoice`, `AutoChoice` in `panel.tsx`, on the one capsule rule | `Chip(..., opens:)` menus in `ChatView.swift` |
| Send | `.send` with kit `SendIcon`, Stop while a turn runs | `.send` with kit `SendIcon`; `.send--stop` with kit `StopIcon` while a turn, a session or an ask is on the go | `KOSButtonStyle(..., round: 30)` with `arrow.right` (Controls) |
| Approval | `Decision.tsx` (Approve, Always, Deny) | `AskCard` in `panel.tsx` (Approve, Always, Deny, with the reason and a `Countdown`) | `AskCard` (`ChatView.swift`) |
| An ask's steps | kit `AskSteps` under the summary: every action a step said by its purpose takes, on the row, wrapped, never cut (Inbox, Needs you, a build's terminal, a chat's loose ask) | kit `AskSteps` in `AskCard` | the `mechanics` line in `AskCard` (`ChatView.swift`) |
| What the chat is beside | | `TabBar` in `panel.tsx` (the tab, a status pill) | `AppCard` (`ChatView.swift`, the app in front) |
| Chat switcher | the chats rail | `ChatSwitcher` in `panel.tsx` | `Switcher` (`ChatView.swift`) |
| Message actions | `MessageActions.tsx` (kit `IconButton`s) | | |
| A quoted selection | kit `QuoteLine` in the owner's bubble | `.quote-chip` in `panel.tsx`, its × a bare kit `IconButton`; once sent, kit `QuoteLine` | |

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
