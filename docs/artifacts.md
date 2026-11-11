# Artifacts

What KOS makes for the owner to read and use: a budget's dashboard, a brief
for the partners, a deck for a meeting, a sheet of expenses. KOS writes each
one as a self-contained HTML document, the way a Claude artifact is written,
and the dashboard shows it live, in a frame that can reach nothing but the
artifact's own project.

Pages written before artifacts as JSON widget specs still render on the
widget renderer, unchanged, as pages.

## Four kinds, one store

Every artifact is HTML underneath and runs in the same frame. Its kind says
which runtime KOS inlines beside it and which design defaults it starts
from. The agent writes content in the kind's simple structure; the runtime
does the hard parts.

| Kind | What it is | The agent writes | The runtime (`packages/ui/pagelib`) does |
| --- | --- | --- | --- |
| `page` | an app, dashboard or tool | any HTML, with `window.kos` for data, `react` and `charts` if named | nothing: the kit's look, as pages always had |
| `doc` | a report, plan, memo, brief or guide | one `<article data-doc>`: a header (`.kicker`, h1, `.lede`, `.byline`), h2 sections, `<span class="fn">` footnotes, figures, `blockquote.pull`, `aside.callout` | `kos-doc`: the reading column and type, numbered notes collected after the text, numbered figures, a table of contents at four or more sections (beside the text when wide, folded above it when narrow), and editing in place |
| `deck` | slides | one `<main data-deck>`, a `<section>` per slide, `<aside class="notes">` for presenter notes; slide classes `.title`, `.statement`, `.split`, `.closing`, `.bleed` | `kos-deck`: 16:9 slides fitted to the frame and sized in container units, keys, clicks and swipes, a counter, a grid of slides, a notes panel, presenting, and a reading layout on a phone in portrait |
| `sheet` | a spreadsheet | one `<script type="application/json" data-sheet>` holding a workbook: tabs with typed columns and rows, a live `source` table, or a `pivot`; `totals`, `freeze`, `charts` | `kos-sheet`: the grid with frozen header and columns, formulas (references, ranges, other tabs, SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, IF, SUMIF, COUNTIF, AVERAGEIF, CONCAT), sorting, filtering, number formats in tabular figures, totals, pivots, charts from ranges, and editing |

The workbook's shape is `SheetBook` in `packages/shared/src/artifacts.ts`,
and `artifacts.write` refuses a kind without its structure (a doc with no
article, a deck with no slides, a sheet whose data is not a valid workbook)
with the reason. The runtimes are KOS's own build, inlined like the
libraries, and each is small: about 17 KB for the doc, 15 KB for the deck,
33 KB for the sheet, minified.

## Where artifacts live

An artifact has one owner, as a file has one folder:

| Owner | Where it lives | Made by | Reaches |
| --- | --- | --- | --- |
| A project | `projects/<slug>/pages/` | the project's chats | the project's tables and files, as declared |
| A blob | `blobs/<name>/artifacts/`, beside the blob's file and whatever else it makes | the blob's own thread, `agent:<name>` | nothing: a blob's turn reaches no tables, so neither does its artifact |
| The workspace | `artifacts/` | anywhere else (a memo, a deck from notes) | nothing |

All three are rows of the one `pages` table (`PageStore`, `systems/pages.ts`):
`project_slug` names a project's, the `blob` and `blob_id` columns a blob's,
and a row with neither is the workspace's. The columns were added to the
table as it was, so every older row kept its project or the workspace.

A blob is told apart by its id, not its name. Each blob is given an id when
it is made (`blob_ids`, `systems/blobids.ts`, kept by `RoleStore`), and its
artifacts' rows carry it. When the blob is removed its id is retired and
never given out again, so a blob made later under the same name, from the
root or from a project's chat with `blobs.create`, is a new owner and owns
none of what the old one made. An id is retired only by `remove()`, by a
write that makes the blob again where its file was not, or at boot
(`RoleStore.reconcile`, once, with a log line) for a blob whose folder went
while KOS was away; a file missing for a moment (an editor's rename-save)
retires nothing. A blob row from before ids went to the living
blob of its name, or to a retired id when that blob was gone. `blob_id` is
indexed.

An id is one artifact's wherever it lives, and the store holds that line
itself: a write replaces only a row of the same owner, or moves one from the
owner its caller checked (`SaveOptions.from`), so a write naming another
owner's id is refused and that artifact is left as it was. An artifact that
moves owner takes its versions and captures with it. The kind, description and
fonts are kept with the declarations. A blob's or a workspace artifact may
not declare writes, file reads or a headline.

Who may reach whose, for every artifacts tool (write, list, get, check,
history, rollback; `whyNot` in `tools/systems.ts`), for `files.*` on an
artifact's file, versions and captures (`artifactFileRefusal`), and for an
`@page` or `@file` mention:

- a project's: its own chats, the turn that made the project, and
  Maintenance; never a blob's thread;
- a blob's: its own thread, the owner's own chats at the root and
  Maintenance, as they reach a blob's files; never a project's chat or
  another blob's. "The owner's own" is a turn the owner started at the root:
  not a schedule's run, a guest's words in a channel, or work passed on;
- the workspace's: any chat.

A path is matched folded (`foldedPath`, `store/workspace.ts`): normalized,
in its on-disk case as far as it exists, and lower-cased throughout, with the
id looked up in any case. The workspace can sit on a case-insensitive disk,
where `Blobs/x/Artifacts/<ID>.html` opens `blobs/x/artifacts/<id>.html`; the
fence refuses it on any disk. `.kos/` is refused the same way, as `.KOS/`.

A turn is the owner's own (`ownership`, `kernel/caller.ts`) only when the
door that took the owner's message says so: the dashboard's API (which the
extension and KOS for Mac use too), a surface's message from the owner
(Discord, iMessage), the CLI, a dashboard fix, rewind or fork. A schedule, a
guest, a resumed approval and a fix KOS starts itself are not. A dispatch or
a handoff passes on no more than the sending turn had, attended and owner
alike, read from the call that sends it.

`@schedule`, `@approval`, `@chat` and `@blob` are fenced the same way: the
root and Maintenance see all of them; a project's chat its project's, a
blob's thread its own, and of anyone else's a schedule's line as `cron.list`
gives it and a blob's description without its brief. Lines a mention-gated
Discord room said in between ride beside the owner's words as context and
are never read for mentions.

A blob's own thread is known by its id, `agent:<name>`, and a living blob of
that name, not by its having no project: a blob's chat in a project works
for the project, and stays so after the project is deleted.

`artifacts.list` leaves out what the chat may not read. A write whose `id`
and `spec.id` differ is refused. A guest's turn has no artifact or file tool,
and a guest's mentions show nothing but the channels they name.

When a blob is removed its file goes and its folder stays with the work in
it, as its files do, and its artifacts are kept: listed as "Removed blob:
<name>", read but never changed by KOS, and the owner's to look at, restore
or put in the trash like any other (below), by its row, so one whose file is
already gone is let go too. Their viewer offers no way to the blob's page,
which is gone, nor Edit with KOS.

## Managing artifacts

The owner renames, copies, moves and deletes artifacts from the dashboard:
the viewer head's menu and each gallery card's menu (`ArtifactManage.tsx`).

- **Rename**: a new title (120 characters at most), description (280), or
  both, trimmed, in a small dialog; an older widget page has a title only.
  The id stays, so `@page:` mentions, the chat's artifact cards and links
  still find it, and the rename is kept as a version. A rename checks
  nothing of the document, which it leaves as it was, so an artifact written
  before a rule it would now fail can still be renamed.
- **Duplicate**: a copy beside it, the same owner's, titled "<title> copy"
  under the first free id `<id>-copy`, `-copy-2` and on (free in any case).
  The copy's history starts with it; the original's stays its own. It is
  written as any new artifact is, every check held, and without the
  original's headline, so the project's card shows one figure.
- **Move**: to any project, the workspace, or a living blob, which becomes
  its owner. Ids are global (one artifact's wherever it lives), so the id and
  every reference to it are kept, and its versions and captures go with it.
  Its document is not checked again, but what it reaches is, against the new
  owner: one that writes, reads or sheets its project's tables, holds a
  headline or reads its files, or an older widget page, stays where those
  are, so a move hands it no data. Nothing goes to a removed blob, and the
  dashboard files nothing in Maintenance, which is KOS's repair shop (a
  Maintenance chat may still move within its own reach). Its versions and
  captures move first, then its file and row, and a failure part way puts
  back what moved. An id is told apart from another in any case, as a disk
  that ignores case tells their files apart: an id that is another's in
  another case is refused for a new artifact or a move.
- **Delete** moves it to the trash (`pages.trashed_at`), never deletes it.
  A trashed artifact drops out of the gallery, the rails, the project's
  page list and its headline, the `@` menu and `artifacts.list`; it keeps its
  file and versions as they were, and nothing changes it (a write, an edit,
  a rollback, a rename, a copy or a move is refused until it is restored),
  nor may a new artifact take its id. Opened by its id (a mention, a chat's
  card, a link) it says it is in the trash, with Restore and Delete forever;
  a chat's card for it says so too. KOS, told of one by a mention, hears
  that it is in the trash and not its body.
- **Trash** is a view of the gallery (Trash in its head), with Restore and
  Delete forever on each card. Delete forever asks once (`ConfirmButton`)
  and removes the row, file, versions and captures. Nothing in the trash is
  deleted on its own, however long it waits; no purge is decided. Deleting a
  project keeps what of it is in the trash: it goes to the workspace's
  trash, still trashed, with its versions and captures, and without what
  reached the project's tables and files.
- In the trash nothing changes it by any road: `files.*` refuses to write,
  edit, move or delete its file, versions or captures (it can still be read),
  its frame's `kos.write` is refused while its reads are answered, and
  `artifacts.check` and the gallery's redraw leave it as it was drawn.

The routes are `POST /api/artifacts/<id>/{rename,duplicate,move,trash,restore,delete}`
(`move` takes `{ project }`, `"@workspace"` for the workspace, or `{ blob }`;
`delete` only from the trash) and `GET /api/artifacts?trashed=1`. They are
the owner's, behind the dashboard's token like every route, and each is kept
in the audit log as `artifact.<verb>`, refusals too. Like every change the
API takes, they are refused when another site's page asks (`crossSiteWrite`,
`kernel/server.ts`): an Origin that is not the dashboard's own host (or the
one a proxy passes on), KOS for Chrome's or on the allowlist, or a
`Sec-Fetch-Site: cross-site` with none. KOS for Mac and the CLI send no
origin and are let by.

KOS has `artifacts.rename`, `artifacts.duplicate` and `artifacts.move`, and
no tool that trashes or deletes. Each is held to the fence above for
changing, at both ends of a move: a project's chat moves its own artifacts
and the workspace's, never into or out of another project, nor into a blob;
the owner's own turn at the root reaches the workspace and blobs but no
project's; Maintenance reaches all. A guest's turn has none of them, and a
call that a guest's words started is refused. `artifacts.list` leaves the
trash out unless asked (`trashed: true`).

## Exporting artifacts

The owner takes an artifact away as a file from the same two menus, the
viewer's and each gallery card's, which list only what its kind has
(`KIND_EXPORTS`, `@kos/shared` `artifactexport.ts`):

| Kind | Formats |
| --- | --- |
| `doc` | PDF, Markdown, HTML |
| `deck` | PDF (a slide a page), HTML |
| `sheet` | CSV (all tabs, or one; the viewer lists each tab), HTML |
| `page` | PDF, HTML |

The file downloads straight from the menu; while it is made the dashboard
says so, and a failure says why. The route is
`GET /api/artifacts/<id>/export?format=pdf|md|html|csv`, with `&tab=` for one
of a sheet's tabs and `&theme=light|dark` (light unless dark is asked; the
dashboard asks for its own palette for HTML and light for a PDF). It is the
owner's: behind the token like every route, and refused when another site's
page asks for it (`fromAnotherSite`, the reading `crossSiteWrite` makes, for
any method), since a request it started would carry the owner's data off as
a download and print in KOS's Chrome. It refuses what is in the trash, an
older widget page, and a format the kind does not have. The name is the
title's (`exportName`), sent as `Content-Disposition` in ASCII and in full
UTF-8. Each export, and each refusal, is kept in the audit log as
`artifact.export`. The work is `ArtifactExporter` (`systems/artifactexport.ts`).

- **Held as on the dashboard.** What the agent wrote may try to send what
  it reads somewhere, by names no write-time check sees
  (`document["loc"+"ation"]`). So an artifact never runs as a page of its
  own, in a render or in the saved file: it runs in the sandboxed srcdoc
  frame (scripts only: no popups, no top navigation, no forms) inside the
  wrapper whose policy lets that frame hold `about:` documents alone, where
  a navigation, a popup or a request goes nowhere. KOS's renders add a
  sealed tab (`systems/exportrender.ts`), offline from the start
  (DevTools' own network emulation), on the tab and on every frame Chrome
  attaches beside it. Its one document is answered by KOS through the
  request's interception, under a name no resolver knows, so no socket is
  opened for it. Every other request is paused and failed (Fetch), a window
  it opens is closed, and the relay binding is heard only from that
  document's own context, not from the artifact's frame nor anything the
  tab becomes after. What each of the ways out that Fetch never sees meets:
  - a WebSocket: the frame's policy (`connect-src 'none'`), and the tab
    being offline; a print runs no script at all;
  - a preconnect, a DNS prefetch or a prerender hint: the exporter takes
    every `link`, `meta` and `base` out of the artifact before drawing or
    saving it (`withoutHints`, `systems/printsafe.ts`), whatever the stored
    lint passed, and the guard refuses making one from script;
  - a navigation's own lookup (Chrome resolves the host a frame is sent to
    before the wrapper's policy refuses it): the same as on the dashboard,
    held at write time only (see What still leaves, below); offline, the
    tab sends no request after it.
  An artifact that tries to leave anyway is left with nothing in its frame,
  and its PDF is refused in words. `artifactexport.chrome.test.ts` plants
  ones that try every way (a computed location, top's, a popup, an image,
  the binding called straight, stored hints, a snapshot that hands back its
  own frames, SVG script, `foreignObject` and a refresh) and counts no
  request, connection or WebSocket on a listener, in a render for HTML, in
  a print, and in the saved file opened from disk.
- **PDF** is printed by the Chrome `artifacts.check` keeps, never the
  machine's print dialog, so nothing asks the owner for a permission. The
  checker's queue (`ArtifactChecker.withBrowser`) runs one job at a time,
  a check or an export, the owner's ahead of the gallery's redraws, each
  held to a ceiling (`JOB_MS`, two minutes) past which the job is given up
  and the Chrome stopped; three exports waiting at most, and each given up
  after 60 s, its tabs closed and its Chrome stopped, since a page that
  spins holds its renderer whatever closes, counted against the three until
  its work has truly ended. The artifact is drawn in its wrapper, its reads
  answered live by the same server-side checks the frame's are and never
  written; then the frame as it was drawn (its markup without scripts, its
  stylesheets, a canvas as its picture) is printed with `Page.printToPDF`.
  That snapshot is read in the artifact's frame after its code ran, which
  can replace every method the reading calls, so it is untrusted text: the
  server rebuilds it with parse5 against an allowlist of what a printed page
  is made of (`systems/printsafe.ts`: no script, frame, object, form, link,
  meta or base, no handler, `srcdoc` or `javascript:`, no `foreignObject` or
  SVG animation, a `use` or link only to `#id`, images only as `data:`, and
  every `url()` in a style to anything but `data:` or `#id` dropped), under
  its own policy that loads and runs nothing, and puts it in a second sealed
  tab with no request at all (`Page.setDocumentContent`), with scripts off
  and the network offline on the tab and every frame Chrome attaches. A deck prints by its
  runtime's print rules on 16:9 pages, every slide whole and nothing after
  the last; a doc on US Letter with margins, on white, its runtime's print
  rules keeping a heading with what follows it and a figure, table, quote
  or code block whole where it fits; a page on Letter, KOS's ground to the
  paper's edges.
- **HTML** is one file that opens anywhere, offline: an outer page under
  the wrapper's policy (no network, no connection, `frame-src about:`)
  that runs nothing of its own, holding the artifact's document in the
  sandboxed frame: its markup with its kind's runtime, its libraries, KOS's
  tokens for the chosen theme, the kit's stylesheet and the fonts it names,
  inlined (dropped for their system stacks past 600 KB, which four families
  do not reach), under the frame's own policy and guard. Its `window.kos`
  reaches nothing: a page, a sheet with a source tab, or a doc or deck that
  names `kos` is drawn once in KOS's Chrome first, and what its reads
  answered is frozen into the file, answered from it by the same call; a
  write, an ask or a save is refused in words, and with no save no runtime
  offers editing. Nothing of the dashboard goes in: no token, no address,
  only the artifact and what its own reads answered. Served with
  `Content-Security-Policy: sandbox`, so a browser that drew it on the
  dashboard's origin would run nothing there.
- **Markdown** (`systems/docmarkdown.ts`) is the doc's article read with
  parse5 and written as CommonMark with GitHub's tables, task lists and
  footnotes: the header's kicker, title, lede and byline, headings, lists
  and checklists, tables (with a caption, a spanned cell padded), figures
  numbered as the doc numbers them, pull quotes and callouts as quotes,
  code fenced with its language, links, and `.fn` notes as `[^n]`. A drawing
  (an SVG or canvas chart) has no Markdown; its figure keeps its caption.
- **CSV** (`systems/sheetcsv.ts`) is a tab's values as the sheet works them
  out, with the runtime's own engine (`sheetformula.ts`, in `@kos/shared` so
  the server and the runtime share it): a formula as its result, a pivot as
  its groups, a source tab as every row its table holds now (not the
  frame's first 500), read through the artifact's own bridge 500 at a time
  and one tab after another, up to 100,000 rows, past which the export is
  refused and the table is the place to export from; a tab whose read is
  refused refuses the export, naming the tab. Numbers plain, to fifteen digits; no totals row;
  RFC 4180 quoting and CRLF; a UTF-8 byte-order mark so Excel reads accents;
  a text cell a spreadsheet would run as a formula led by an apostrophe.
  Every tab of a sheet with more than one is a zip of a CSV each.

## How an artifact is written

The tools are `artifacts.guide`, `artifacts.write`, `artifacts.patch`,
`artifacts.check`, `artifacts.list`, `artifacts.get`, `artifacts.history` and
`artifacts.rollback`, with `artifacts.rename`, `artifacts.duplicate` and
`artifacts.move` (Managing artifacts, above). The agent's instructions say an artifact is one of the
four kinds, that "make me a doc, slides or a spreadsheet" names the kind, and
that it reads the guide, writes, checks once, fixes what the check reports
in one pass and finishes.

`artifacts.guide({ kind })` returns KOS's design guide
(`systems/artifactguide.ts`): the general part, then the kind's. It is read
on demand, not sent with every prompt. It covers deciding the treatment,
grounding the artifact in its subject and real data, building on KOS's own
tokens and face (the default, so an artifact sits on the dashboard as part
of KOS; only a piece meant to stand apart, a poster or an invitation, writes
a token plan of its own), both themes, type, layout (sections set apart by
rules and space, cards only for discrete objects), charts, being complete at
rest, avoiding the generated look, copy, naming and building cleanly, then
the kind's structure and conventions.

`artifacts.write` takes the project (omitted for a new workspace artifact;
omitted on a rewrite, the artifact stays where it is, and `"@workspace"`
moves it out of its project), an id, the kind, a title (a short name), a description (one sentence), the
HTML, and what it declares:

- `capabilities.query`: read-only queries of the project's own tables, on
  unless set false.
- `capabilities.writes`: the tables it may change, each with its editable
  columns and operations (insert, update, delete), named by their physical
  table. A sheet over a table edits through these.
- `capabilities.files`: read text files inside the project's folder.
- `capabilities.ask`: offer a message to the project's chat; the owner
  confirms each one.
- `libraries`: `react` and `charts`, the only two, which KOS serves itself.
- `fonts`: bundled fonts by id, at most four; the kind's own when absent.
- `headline`: `{ label, query }`, the figure on the project's card.

Every write is kept as a version under the artifact's folder, in
`.history/<id>/`, the last 30. `artifacts.history` lists them and
`artifacts.rollback` puts one back, as does Roll back on the artifact itself;
a rollback is a version too, so it can be undone.

### Changing part of one

`artifacts.patch({ id, edits })` changes part of an artifact and leaves the
rest as it is, so a new title or one more row costs its own words rather than
the whole document again (`systems/artifactpatch.ts`). Each edit is
`{ find, replace }`, where `find` is an exact piece of the stored HTML (as
`artifacts.get` returns it) that occurs exactly once, or every occurrence
with `all: true`; or `{ id, html }`, which replaces the one element with that
id whole, found by parsing the HTML with parse5 (an id in a script's text is
not an element, and an element whose end tag is implied is refused). Edits
apply in order to a copy, all or none, at most 50, and a refusal names the
edit and why (missing, or how many times it occurs). The result is the
whole document again, written through `writeHtml` as any write is: every
write check, the doc's editor allowlist, the fence on who may change it, the
trash and a guest's words refused as for `artifacts.rename`, and a version
kept. Then, where KOS has Chrome, it is checked as `artifacts.check` checks
it. What comes back is one line (the new version, how many places changed,
lines out and in, bytes before and after) and the check's findings, never
the document. A doc is patched in its stored form: what its runtime draws
(contents, note numbers, anything marked `data-kos-gen`) is not stored, and
an edit that adds `data-kos-gen` is refused. The guide and the agent's
instructions say to patch a targeted change and rewrite with
`artifacts.write` only for a redesign; "Edit with KOS" asks the same.
`files.*` only reads an artifact's document, versions and captures: a
`files.write`, `files.edit`, or a `files.cp` or `files.mv` onto any of them
is refused and points to `artifacts.patch`, since it would skip every check
and keep no version; and a `files.rm` or a `files.mv` from one, or from a
folder holding one, is refused and points to the owner's trash.

## The owner's edits

A doc's text and a sheet's cells are edited in place. The runtime sends the
edit with `kos.save`, and the server keeps it as the next version
(`PageStore.applyEdit`). Only the kind's own region changes: the inside of a
doc's article, or a sheet's data script. A doc's edit is parsed as the
browser parses it (parse5, `systems/markup.ts`): entities decoded, names
lower-cased, a `>` inside a quoted attribute read as text. It is held to the
elements and attributes a doc is made of; a link may go only to `#id` and an
image only be `data:image/`; a script, stylesheet, handler, `javascript:` URL
(however encoded) or article tag is refused; a style or an SVG paint, mask,
clip, filter or marker holding a backslash (a CSS escape), `image-set(` or a
`url(` to anything but `#id` is refused, as is `<use>` or `<feImage>` naming
anything off the page; and what is saved is the parse
written back out, so a stray end tag cannot end the article early. A
sheet's data is re-serialised with `<` escaped, so it cannot end its script,
and may not change which tables the sheet reads. Then the whole document
goes through every check a write does. A page or a deck is not edited in
place; "Edit with KOS" asks for the change instead.

A save is the owner's: the dashboard relays `kos.save` only while the
owner's hand is in that frame (`ownerIn`: the dashboard's focus is on it and
the browser counts a gesture as active), or within 2.5 s (`DONE_MS`) of the
dashboard's own Done, which covers the doc waiting out the gap between
saves. A Done opens that window only when the owner pressed or typed in the
document since it loaded or last saved, and the window lets one save
through, so a doc only looked at saves nothing on the way out. A press elsewhere on the dashboard, and Discard, Undo or Edit sent
from it, end that leave, so a page cannot turn a click on the dashboard into
a save (`saveAllowed`, `widgets/frameheight.ts`). The dashboard sends the version the edit was
made on (the record's `updatedAt`); if KOS or another window saved since,
the server answers 409 and the dashboard says so and offers a reload rather
than overwrite the newer version. An edit that changes nothing is refused,
and an artifact takes one edit every 2 s (`EDIT_GAP_MS`); the sheet runtime
spaces its saves to match.

### Editing a doc

Edit makes the doc editable where it is drawn, as a document editor does
(`ui/pagelib/docedit.ts`): a bar of formats over a selection (bold, italic,
code, a link to one of the doc's headings, H1 to H3, lists, quote), a "/"
menu of blocks at the start of an empty line (headings, lists, a
checklist, a quote, a divider, a table, a callout, an image from a file),
markdown typed at a line's start (`# `, `## `, `- `, `1. `, `> `, `[] `)
and around words (`**bold**`, `` `code` ``). A drop is taken as plain text,
as a paste is. Editing leaves the doc laid out as it reads: its contents,
its column and its numbered notes stay where they were, the numbers never
typed into; pressing one opens its note in the line to edit. Leaving
editing numbers the notes and builds the contents again only when
something changed. Its controls are the dashboard's, in the viewer's head
that stays in view as the doc scrolls by (Edit, then Undo, Redo, Discard,
Done and how the save stands): the doc says how its editing stands
(`{__kos: "edit", editing, pending, status}`) and the dashboard sends what
the owner pressed (`{__kos: "edit-do", action}`). The selection's format bar
stays in the frame.

It saves on its own 1.2 s after the owner stops typing, through the same
`kos.save`, so the gesture, conflict and rate rules above all hold. Saves run
one after another, and each waits out the 2.1 s since the last, so Done (or
Cmd+S, or Escape) just after one is never refused as too soon; Done saves
what is waiting and draws the doc again, and stays in editing if the save
was refused. Discard puts back what was not yet saved and leaves editing.
An edit longer than the server takes (`DOC_EDIT_MAX`, 300,000 characters) is
not sent, and an image is kept to well under it, counting base64's growth.
Before the frame goes (another version, another artifact, back, another
thread beside it, another route by any means), the viewer asks the doc to
finish, so nothing typed is lost; that save is allowed by the Done window. A
page that says it is editing holds the dashboard 2.5 s at most
(`SETTLE_MS`). A restore made while an edit waits names the version that
edit saved, not the one first opened. An artifact opened beside a thread
while that wait runs stays open.

It runs inside the doc's frame, on the browser's own editing
(contenteditable and its commands), not on an editor library's model: a
schema would drop what the agent wrote and it did not know (a callout, a
pull quote, a footnote, a class), and undo is the browser's. Nothing new
leaves the frame, so the frame's policy, Trusted Types and the guard are as
they were; the markup it makes is the doc's own (no forms, frames or links
off the page; a link goes to a heading, since a frame has nowhere else to
go). An image is read from a file the owner picks and kept inline as data,
up to 300 KB.

### Editing from anywhere, written in one place

The owner can edit an artifact wherever it shows: on the Artifacts page, in
its project, opened from a blob's list. Every such edit goes through the
same `kos.save` to `PageStore.applyEdit` for that artifact, which changes it
where it lives: an edit never moves an artifact, gives it a capability, or
reaches another project's tables. KOS's own writes keep their fence as
before (`artifacts.write` writes the calling project's, or the workspace's);
there is no new path for one project to write another's artifact.


## Fonts

The frame has no network, so KOS bundles a small set of open-licensed (SIL
OFL) families, latin only, variable where the family is, in
`packages/ui/pagelib/fonts/` (636 KB in all, with their licences):

| Role | Families |
| --- | --- |
| Serif | Newsreader (reading), Literata (book), Bodoni Moda (display) |
| Sans | Public Sans (neutral), Hanken Grotesk, Schibsted Grotesk, Bricolage Grotesque (display) |
| Mono | IBM Plex Mono, JetBrains Mono |

An artifact names the ones it uses in `fonts`; the frame inlines only those,
as `data:` URLs (which its policy allows), and sets `--font-<id>` to each
family's stack with real fallbacks. Every kind starts from the system face
KOS itself is set in; a doc adds Newsreader for its running text only, which
reads well on KOS's ground in both themes. The other families are for a
piece that names them.
`artifactfonts.ts` in `@kos/shared` is the list.

## Checking before the owner sees it

`artifacts.check({ id })` (`systems/artifactcheck.ts`) draws the artifact
exactly as the dashboard does (the same wrapper, document, policy, guard,
bridge, tokens, kit CSS, fonts and runtime, from the dashboard's build in
`dist/page-lib`, held in a column with the dashboard's gutter on KOS's
ground) in a headless Chrome KOS starts for it and closes when idle,
at 1280 and 390 px wide, in light and in dark, with the machine's own
preference set to the other theme so an artifact that follows the OS rather
than KOS's toggle is caught. Its `window.kos` reads are answered by the same
server-side checks; it never writes. It then measures the frame
(`artifactprobe.ts` in `@kos/browser`) and reports, as sentences:

- sideways overflow, and the element that causes it;
- text cut off by a box that hides what overflows it (a tile too narrow for its words);
- text drawn over other text;
- colours that stay the same in both themes (the body's background, or most
  text), the sign of a literal colour or a token with one value;
- text below AA contrast against what is behind it;
- console errors and uncaught exceptions;
- `window.kos` calls that failed, with the refusal;
- boxes drawn as regions that hold nothing at rest;
- a formula error showing in a sheet;
- no visible title;
- an attempt to leave the frame;
- and, as small findings after the rest, the generated look the guide warns
  of: a large area in the other theme's brightness (an inverted slide or
  band), three or more wide bordered boxes each wrapping a section (a head
  and a table, list, chart, form or box; not cards for objects, nor lanes
  side by side), big figures reading a placeholder or a whole row of zeros,
  bar tracks that all draw no fill, and, from an artifact that declares no
  token plan of its own, an inverted area or a ground other than KOS's.

With the words come two small screenshots, the desktop in light and the
phone in dark, which the model sees. Each render's screenshot is kept in
the artifact's `.captures/<id>/`.

## The Artifacts page

Artifacts on the dashboard's nav is a gallery of every artifact across
projects, blobs and the workspace, newest first. Its head holds the count, a
search over titles, descriptions and owners, and New artifact, which opens KOS's
root chat with "Make a " in the composer for the owner to finish. Under it,
the kinds as chips with how many each holds (one row that scrolls sideways
on a phone), the owner (Everyone's, the workspace, each project, each blob),
and Recent or By owner: one grid, or a section per owner with the
workspace's own last. A card is a 16:10 capture cropped from the top, the
title, one line of description, the kind, the owner's mark and name (a
project's mark, or a blob's face), and when it changed. While the list loads the grid is drawn
as skeleton cards; with nothing made it says so, beside New artifact.

The thumbnail is the capture `artifacts.check` keeps, in the dashboard's
theme, not a live render: a gallery of live frames would start every
artifact's runtime and queries at once just to draw stamps, while a capture
costs nothing to show. A missing capture, or one older than the artifact,
is redrawn when the gallery opens, one at a time in the background
(`POST /api/artifacts/<id>/check`), at most eight in a visit; until then the
card shows its kind. An agent's `artifacts.check` goes ahead of any redraws
still waiting. An older widget-spec page is listed too, marked as one; it
has no capture, and its viewer offers Convert with KOS, which asks its
project's chat to rewrite it as an HTML artifact under the same id.

Opening one shows it full size under one compact row that sticks as it
scrolls (`ArtifactHead.tsx`): back, the owner and the title as a
breadcrumb, the kind and when it changed, and its actions; the artifact
keeps its own title below, so the head says it once, small, and its
description waits in the row's menu. The frame's own controls are in that
row too, so there is one toolbar: a doc's editing (below), and a deck's
slide, notes and grid, which the deck reports (`{__kos: "deck", index,
count, grid, notes, reading, hosted}`) and the dashboard presses
(`{__kos: "deck-do", action}`), its own bar handed over on the first
report and kept when it stands alone. On a phone the row is the title and
the menu, with Done in reach while editing. The actions: History (a drawer of every version,
newest first, each older one with Preview, which shows that version in place
with nothing in it saved, written or asked, and Restore, which like an edit
names the version it was made on and is refused with a 409 when one was
saved since), Open and the owner's name (its project's page, or its blob's),
Present
for a deck (the frame goes full screen and tells the deck to present), and Edit
with KOS (the owner says what should change, and it goes to the chat that
owns the artifact: the project's, the blob's thread, or KOS at the root).

When a turn writes one, the chat shows it as a card in place of the
`artifacts.write` step (`ArtifactStep.tsx`): its capture (or its kind's
mark until there is one), title, kind and owner, with Open, which goes to
it on its own page, and Open here, which opens it in place of the thread as the
list beside a project's chat does.

The same viewer shows an artifact opened from its project (`#/page/<id>`),
and in place of the chat when one is picked from the Artifacts list beside a
project's or a blob's chat (`ArtifactRail.tsx`): what that project or blob
owns and nothing else (a blob's list is its own, not those of the projects it
works in), each one's kind, title and when it changed. On a narrow window the
list folds into one row under the chat. The list is read when the page opens,
when the artifact open in place closes, and when a turn ends, since a turn is
what makes one. Another thread, project or blob shows its thread again, not
the artifact open before. Edit with KOS there goes to the owning thread and
shows it; History, Restore and the owner's edits work as on the Artifacts
page, and an older widget page opens on its own page.

### Drawn as part of the page

An artifact is drawn on the dashboard's own ground, with no border and no
scroll of its own: a frame with a fixed height and its own scrollbar is what
made a page feel like an iframe rather than part of KOS. Wherever one is
shown (its project, the viewer, full screen):

- A page or a doc is as tall as its content. The bridge watches the page
  (a ResizeObserver on its `<html>` and `<body>`, debounced 60 ms) and posts
  `{__kos: "height", height}`; the dashboard sets the frame to it, so the
  dashboard scrolls as one page. The page keeps its own scrollbar only while
  its frame is shorter than it (the check's fixed view, or past the cap),
  and its sideways overflow is hidden.
- A frame opens at the height it last took at about that width
  (`rememberedHeight`, kept per artifact and 160 px width bucket, in memory
  and for the tab's session; never from an older version shown to look
  at), a skeleton in its place, and cross-fades in once its page's first
  heights have been quiet for 160 ms, at the last, or once a deck says it
  has handed over its bar; a frame that has said nothing is shown 1.5 s
  after it loads, a sheet as soon as it has drawn, and one that hit an
  error at once. So opening one again never jumps, and the first time
  settles once. Reduced motion drops the fade.
- The height is the page's to say, so the dashboard holds it
  (`widgets/frameheight.ts`): within 80 px and 50,000 px, a change under
  2 px ignored, a return to the height before last within 400 ms ignored,
  and more than twelve changes in 1.5 s freezes the frame where it is until
  the page has been quiet for 2 s, so a page sized to its own frame cannot
  make the dashboard jump or loop. Changes while the owner's hand is in the
  frame (typing a run of new lines) never count towards a freeze. While the
  frame is not the height it reported, the bridge sends it again, backing
  off, so a height set aside is taken once the page settles. The message is
  heard only from the page's own frame, like every other.
- With no scroll of its own, a jump to a place on the page (a `#id` link,
  `scrollIntoView`, a doc's contents and notes) is posted as the same
  message with `reveal: {top, bottom, block}`, and the dashboard scrolls
  whatever holds the frame to it, held within the frame, and only while the
  owner's hand is in that frame and within 500 ms (`REVEAL_MS`) of their
  press or key in it. The bridge, before any of the page's code runs, hands
  the dashboard a channel of its own and tells it over that channel of each
  trusted press and key in the frame; the page never holds the channel, and
  a second one is ignored, so a page cannot move the dashboard by itself and
  a press elsewhere does not count. While the frame has a scroll
  of its own (past the cap, frozen, or the check's fixed view), a jump scrolls
  inside it too.
- A doc's contents beside the text stay in view: the dashboard tells the doc
  where its view is over the frame (`{__kos: "view", top, height}`, numbers
  only, once a frame), and the doc moves its contents to match.
- A deck is a 16:9 stage as wide as the room, under the viewer's head, never taller
  than the view; a sheet fills the view below where its frame starts, and
  its runtime gives the grid what is left under its head and tools, so only
  the grid scrolls. On a phone, sideways too: the grid's box is contained
  inline there, so a wide grid never widens what holds it, and the page
  never scrolls sideways. Wider, the box sizes to its grid, so a sheet in
  something sized to its content is never clipped, up to the view less its
  gutters, past which the grid scrolls in its box. On a phone the row
  numbers and a frozen first column stay put sideways; other frozen columns
  scroll away but keep their header and total in view. A phone narrows the
  grid before it scrolls (text wraps, a column's `width` is a desktop's),
  holds the key figure (the first column the tab totals, else its first
  currency) at the box's right edge, and says in the tools how many columns
  are out of view.

## What an artifact runs in

The dashboard frames a small wrapper document, and the wrapper frames the
page. Both are `srcdoc` iframes with `sandbox="allow-scripts"` and no
`allow-same-origin`, so both are opaque origins: the page cannot read the
dashboard's DOM, cookies, storage or token.

Each layer stops something the others do not. All of it was tried in a real
Chrome by a page attempting every way out (`artifact.chrome.test.ts`, which
also runs the old flat frame as a control and sees it leak):

| Layer | What it stops |
| --- | --- |
| The sandbox: scripts only | `window.open` and `target=_blank` (no popups), forms (no `allow-forms`), navigating the dashboard or any frame but the page's own (`top.location`, `parent.location`, `target=_top`) |
| The page's policy, first in its head: no network | fetch, beacons, sockets, event streams, workers' fetches, external images, fonts, styles, scripts, objects and frames |
| The wrapper's policy: its frame may hold `about:` documents and nothing else | the page sending itself anywhere: `location.href`, `assign`, `replace`, a meta refresh, a link it clicks, a download link, `data:` and `blob:` documents. A frame's navigation is checked against its parent's policy, and a `srcdoc` frame inherits its parent's policy, so the page can narrow it but never widen it |
| Trusted Types and the guard script, run before the page's own | the elements no policy governs: `<link rel=prerender>` (which sends a real request whatever the policy says), other prefetch links, speculation rules, `<meta>`, `<iframe>` (a fresh realm), `<form>`, `<object>`, `<base>`, `<script>`, in any namespace and under any prefix. Every string the page turns into HTML (`innerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, ranges, shadow roots, templates) goes through one policy that refuses their markup; `createElement`, `createElementNS` and `createDocument` refuse them; and since a parser can still make one (an XML entity, another document), no node holding one may be adopted, imported or placed by any insertion method (`appendChild`, `insertBefore`, `replaceChild`, `append`, `prepend`, `replaceChildren`, `replaceWith`, `before`, `after`, `insertAdjacentElement`, `moveBefore`, a range's `insertNode` and `surroundContents`). A `<link>` takes no `rel` or `href`. WebRTC (STUN goes out over UDP beside every policy) and XSLT are taken away. All of it is fixed in place, and it checks with built-ins held from before the page runs, so a page that replaces `Function.prototype.call` or `RegExp.prototype.exec` changes nothing |
| `artifacts.write` | the same in the page as written: `<link>` (prefixed too), `<meta http-equiv>`, frames, objects, `<base>`, `<form>`, speculation rules, link or form targets, download links, links off the page; in its code `location`, `open()`, setting a link's `href` or `target`, `submit()`, `navigation.navigate`, WebRTC. Code is read with its strings and comments blanked, so "Pick a location" or `row.location` pass. The page is refused with what it held, because a page that tries one only breaks (it has no network to reach), and because of the one leak below. This is a best reading of the code, not a parser |

**What still leaves.** When a page starts a navigation, Chrome opens a
connection to the host it names (a DNS lookup and a TCP connect) before the
wrapper's policy refuses it. No request is sent, so no path, query or body
leaves, but the host name itself does, and a name can carry a little data.
An opaque frame has no Navigation API, which is the one way to cancel a
navigation before it starts, so this is held at write time only: a page that
names `location` or a link target plainly is refused, and one that hides it
behind computed names is not caught.

The markup part of that check (a link, frame, form, base, meta refresh, link
target, download, or a link or media off the page) is read twice: by
patterns in `@kos/shared` (`htmlpage.ts`), and on the server from the
document as parse5 builds it (`markupExits`, `systems/markup.ts`), so an
exit behind an entity, a quoted `>`, a new line or upper case is refused as
well. The parser stays on the server; nothing of it ships to the dashboard.

Before the page's own markup the frame gets:

- `data-theme` and `data-mode` on its `<html>`, `light` or `dark` from the
  dashboard's theme, changed live when the owner switches, so an artifact's
  dark tokens under `:root[data-theme=dark]` (and its
  `prefers-color-scheme` rules guarded by `:root:not([data-theme=light])`)
  follow KOS's toggle rather than the machine's setting; and `data-kind`;
- KOS's tokens as CSS variables, for the dashboard's theme at that moment,
  and again whenever the owner switches theme;
- `kit.css` and `page.css` from `@kos/kit`, so plain markup and the kit's
  classes read as KOS, whatever the kind. The body has KOS's ground and face
  and no padding: the frame is always held by something that gives it a
  gutter (the dashboard's column, the check's view), so its edges line up
  with the dashboard's head; full screen (`data-present`), or when the page
  paints a ground of its own (the bridge marks `data-ground="own"` when the
  body's background is not KOS's `--bg`), it takes its own, so its text
  never meets the edge of its colour. Each runtime starts from the same ground: a doc's text on it in a
  reading serif under headings in KOS's face, a deck's slides as KOS's panel
  with a 1 px line (the title slide too, never inverted), a sheet's grid on
  KOS's panel;
- the fonts it names, as `@font-face` rules with the files inlined, and
  `--font-<id>` stacks for every bundled family;
- the `window.kos` bridge, which talks to the dashboard as `top`, reports
  a page's or a doc's height (above), and makes a link to a place on the
  page (`#id`) scroll there: in a `srcdoc` frame it would resolve against
  the dashboard's address and send the frame away;
- the libraries it named and its kind's runtime, inlined from the
  dashboard's own build (`dist/page-lib/`). A library missing from the build
  is a 404, never the dashboard's own page, and the frame takes only a
  script. A runtime adds its stylesheet right after itself, before the
  artifact's own, so the artifact's CSS wins without a fight.

## window.kos

| Call | What it does |
| --- | --- |
| `kos.query(sql, params?)` | A single read-only SELECT over the page's project's tables, at most 500 rows and 2 s. |
| `kos.write(table, op, values, key?)` | One insert, update or delete on a declared table, through the same guarded mutation path the widgets use. |
| `kos.files.read(path)` | A text file inside the project's folder, up to 256 KB. |
| `kos.ask(text)` | The owner sees the text and chooses whether to send it to the project's chat. |
| `kos.theme`, `kos.onTheme(fn)` | The dashboard's theme, and its changes. |
| `kos.refresh(fn)` | Run again after the page's own writes. |
| `kos.save(edit)` | A doc's or a sheet's edit, made by the owner in the runtime, kept as the next version (above). Refused for a page or a deck. |
| `kos.present(on?)` | Ask the dashboard to show the artifact full screen (`kos.present(false)` gives it back); it then posts `present` on and off, which sets `data-present` on `<html>` and fires `kos:present`. Where the browser has no full screen for an element (Safari on an iPhone) or refuses, the artifact presents in place in its frame, and Escape or Present again ends it. |

The dashboard only relays these, for its own frame. The server decides each
one (`packages/harness/src/systems/pagebridge.ts`) against the page's stored
declarations:

- A project's tables are the ones its own migrations made (`systems.migrate`,
  followed through renames), never a name that starts with its slug: a
  project called Permission does not own `permission_rules`. A new project
  never gets a slug that is, or prefixes, a table that already exists.
- A query is asked of SQLite's own plan, not read from its text. Every table
  it opens, through a join, a subquery, a CTE or a view, must be one of the
  project's. The schema, KOS's own tables, other databases and virtual
  tables (pragmas, full-text indexes) are refused.
- A query runs in a child process with its own read-only connection, capped
  at 500 rows and about 2 MB of values, and is killed 2 s after it was asked,
  time waiting for a turn included: SQLite cannot be interrupted from Node,
  so a recursive CTE that never ends would otherwise hold the server. A page
  has one query running and four waiting at most; more are refused, so one
  page cannot starve the rest. The bridge sends a frame's queries two at a
  time and holds the rest in the frame, so a page that asks for ten at once
  (`Promise.all` over its charts) gets ten answers, and the viewer and a
  check's render of the same artifact still fit. Headlines run the same way, with 1 s, and are
  kept for 30 s or until the page changes; the page list waits on them for
  1.2 s at most. Closing KOS kills every child, and a child whose server
  goes exits by itself.
- A write must name a table the page declared, with only its declared
  columns and operations, and that table must be the project's. Values are
  text, numbers, null, or true and false (as 1 and 0).
- A file must be inside the project's folder, and not in `pages/` (the
  project's pages and their history) or any `.history` folder, in any case. Only its first
  256 KB are read.

A refusal is answered with a sentence the page can show, and recorded in the
audit log as `page.query`, `page.write` or `page.file`. It is the same
sentence whether a table is missing, another project's or KOS's own, so a
page cannot use refusals to learn what else the workspace holds.

## When an artifact goes wrong

- A page is checked when it is written: its size (400,000 characters at
  most), its libraries, its declarations, that its write targets exist and are
  its own project's, that its headline is read-only, and that it holds
  nothing that would try to leave its frame. A bad page is refused with the
  reason, before anyone sees it.
- An error the page throws is shown above it with **Fix with KOS**, which
  asks the project's chat to fix the page by its id. The error is the page's
  own text, so it goes along only as a fenced, capped quote marked untrusted.
- A page whose frame loads anything a second time (it tried to leave and was
  refused) is removed, with the same button.
