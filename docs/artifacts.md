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

An artifact belongs to a project, under `projects/<slug>/pages/`, or to no
project, as a workspace artifact under `artifacts/` (a memo, a deck from
notes). A workspace artifact has no tables or files to reach, so it may not
declare writes, file reads or a headline. Both are rows of the one
`pages` table (`PageStore`, `systems/pages.ts`); the kind, description and
fonts are kept with the declarations.

## How an artifact is written

The tools are `artifacts.guide`, `artifacts.write`, `artifacts.check`,
`artifacts.list`, `artifacts.get`, `artifacts.history` and
`artifacts.rollback`. The agent's instructions say an artifact is one of the
four kinds, that "make me a doc, slides or a spreadsheet" names the kind, and
that it reads the guide, writes, checks once, fixes what the check reports
in one pass and finishes.

`artifacts.guide({ kind })` returns KOS's design guide
(`systems/artifactguide.ts`): the general part, then the kind's. It is read
on demand, not sent with every prompt. It covers deciding the treatment,
grounding the artifact in its subject and real data, a token plan in the
artifact's `:root`, both themes at the token level, type, layout, charts,
being complete at rest, avoiding the generated look, copy, naming and
building cleanly, then the kind's structure and conventions.

`artifacts.write` takes the project (omitted for a workspace artifact), an
id, the kind, a title (a short name), a description (one sentence), the
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

## The owner's edits

A doc's text and a sheet's cells are edited in place. The runtime sends the
edit with `kos.save`, and the server keeps it as the next version
(`PageStore.applyEdit`). Only the kind's own region changes: the inside of a
doc's article, or a sheet's data script. A doc's edit is text, so a script,
stylesheet, handler, `javascript:` URL or article tag in it is refused; a
sheet's data is re-serialised with `<` escaped, so it cannot end its script,
and may not change which tables the sheet reads. Then the whole document
goes through every check a write does. A page or a deck is not edited in
place; "Edit with KOS" asks for the change instead.

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
family's stack with real fallbacks. A doc starts from Newsreader, Public Sans
and Plex Mono, a deck from Bricolage Grotesque and Public Sans, a sheet from
Public Sans and Plex Mono, and a page from the system face KOS uses.
`artifactfonts.ts` in `@kos/shared` is the list.

## Checking before the owner sees it

`artifacts.check({ id })` (`systems/artifactcheck.ts`) draws the artifact
exactly as the dashboard does (the same wrapper, document, policy, guard,
bridge, tokens, kit CSS, fonts and runtime, from the dashboard's build in
`dist/page-lib`) in a headless Chrome KOS starts for it and closes when idle,
at 1280 and 390 px wide, in light and in dark, with the machine's own
preference set to the other theme so an artifact that follows the OS rather
than KOS's toggle is caught. Its `window.kos` reads are answered by the same
server-side checks; it never writes. It then measures the frame
(`artifactprobe.ts` in `@kos/browser`) and reports, as sentences:

- sideways overflow, and the element that causes it;
- text cut off by a box that hides what overflows it (a tile too narrow for its words);
- colours that stay the same in both themes (the body's background, or most
  text), the sign of a literal colour or a token with one value;
- text below AA contrast against what is behind it;
- console errors and uncaught exceptions;
- `window.kos` calls that failed, with the refusal;
- boxes drawn as regions that hold nothing at rest;
- a formula error showing in a sheet;
- no visible title;
- an attempt to leave the frame.

With the words come two small screenshots, the desktop in light and the
phone in dark, which the model sees. Each render's screenshot is kept in
the artifact's `.captures/<id>/`.

## The Artifacts page

Artifacts on the dashboard's nav is a gallery of every artifact across
projects and the workspace, newest first, filtered by kind and project and
searched by title and description. A card shows a thumbnail, the title, the
description, the kind, the project and when it changed.

The thumbnail is the capture `artifacts.check` keeps, in the dashboard's
theme, not a live render: a gallery of live frames would start every
artifact's runtime and queries at once just to draw stamps, while a capture
costs nothing to show. A missing capture, or one older than the artifact,
is redrawn when the gallery opens, one at a time in the background
(`POST /api/artifacts/<id>/check`); until then the card shows its kind.

Opening one shows it full size with its version history and Roll back,
Edit with KOS (the owner says what should change, and it goes to the chat
that owns the artifact: the project's, or KOS at the root), and Present for
a deck, which takes the frame full screen and tells the deck to present.

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

Before the page's own markup the frame gets:

- `data-theme` and `data-mode` on its `<html>`, `light` or `dark` from the
  dashboard's theme, changed live when the owner switches, so an artifact's
  dark tokens under `:root[data-theme=dark]` (and its
  `prefers-color-scheme` rules guarded by `:root:not([data-theme=light])`)
  follow KOS's toggle rather than the machine's setting; and `data-kind`;
- KOS's tokens as CSS variables, for the dashboard's theme at that moment,
  and again whenever the owner switches theme;
- `kit.css` and `page.css` from `@kos/kit`, so plain markup and the kit's
  classes read as KOS, whatever the kind;
- the fonts it names, as `@font-face` rules with the files inlined, and
  `--font-<id>` stacks for every bundled family;
- the `window.kos` bridge, which talks to the dashboard as `top`, and makes
  a link to a place on the page (`#id`) scroll there: in a `srcdoc` frame it
  would resolve against the dashboard's address and send the frame away;
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
| `kos.present()` | Ask the dashboard to show the artifact full screen; it then posts `present` on and off, which sets `data-present` on `<html>` and fires `kos:present`. |

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
  page cannot starve the rest. Headlines run the same way, with 1 s, and are
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
