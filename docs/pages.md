# Pages

A project's pages are what KOS builds for the owner to look at and use: a
budget's spending, a workout log, a study plan. KOS writes each one as a
self-contained HTML document, the way a Claude artifact is written, and the
dashboard shows it live, in KOS's look, inside a frame that can reach nothing
but the page's own project.

Pages written before this as JSON widget specs still render on the widget
renderer, unchanged; KOS writes new ones as HTML.

## How a page is written

`pages.write` takes the project, an id, a title and the HTML, plus what the
page declares:

- `capabilities.query`: read-only queries of the project's own tables, on
  unless set false.
- `capabilities.writes`: the tables the page may change, each with its
  editable columns and operations (insert, update, delete), named by their
  physical table.
- `capabilities.files`: read text files inside the project's folder.
- `capabilities.ask`: offer a message to the project's chat; the owner
  confirms each one.
- `libraries`: `react` and `charts`, the only two, which KOS serves itself.
- `headline`: `{ label, query }`, the figure on the project's card.

The tool's description is the authoring guide the agent reads: the bridge,
the tokens and classes, the libraries, and working from 390 px wide.

Every write is kept as a version under
`projects/<slug>/pages/.history/<id>/`, the last 30. `pages.history` lists
them and `pages.rollback` puts one back, as does Roll back on the page itself;
a rollback is a version too, so it can be undone.

## What the page runs in

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
| Trusted Types and the guard script, run before the page's own | the elements no policy governs: `<link rel=prerender>` (which sends a real request whatever the policy says), other prefetch links, speculation rules, `<meta>`, `<iframe>` (a fresh realm), `<form>`, `<object>`, `<base>`, `<script>`. Every string the page turns into HTML (`innerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, ranges, shadow roots, templates) goes through one policy that refuses them; `createElement` and `createElementNS` refuse them and are frozen; XSLT is taken away |
| `pages.write` | the same constructs in the page as written: `<link>`, `<meta http-equiv>`, frames, objects, `<base>`, `<form>`, speculation rules, link or form targets, download links, and in its code `location`, `window.open`, `submit()`, `navigation.navigate`. The page is refused with what it held, because a page that tries one only breaks (it has no network to reach), and because of the one leak below |

**What still leaves.** When a page starts a navigation, Chrome opens a
connection to the host it names (a DNS lookup and a TCP connect) before the
wrapper's policy refuses it. No request is sent, so no path, query or body
leaves, but the host name itself does, and a name can carry a little data.
An opaque frame has no Navigation API, which is the one way to cancel a
navigation before it starts, so this is held at write time only: a page that
names `location` or a link target plainly is refused, and one that hides it
behind computed names is not caught.

Before the page's own markup the frame gets:

- KOS's tokens as CSS variables, for the dashboard's theme at that moment,
  and again whenever the owner switches theme;
- `kit.css` and `page.css` from `@kos/kit`, so plain markup and the kit's
  classes read as KOS;
- the `window.kos` bridge, which talks to the dashboard as `top`;
- the libraries the page named, inlined from the dashboard's own build
  (`dist/page-lib/`).

## window.kos

| Call | What it does |
| --- | --- |
| `kos.query(sql, params?)` | A single read-only SELECT over the page's project's tables, at most 500 rows and 2 s. |
| `kos.write(table, op, values, key?)` | One insert, update or delete on a declared table, through the same guarded mutation path the widgets use. |
| `kos.files.read(path)` | A text file inside the project's folder, up to 256 KB. |
| `kos.ask(text)` | The owner sees the text and chooses whether to send it to the project's chat. |
| `kos.theme`, `kos.onTheme(fn)` | The dashboard's theme, and its changes. |
| `kos.refresh(fn)` | Run again after the page's own writes. |

The dashboard only relays these, for its own frame. The server decides each
one (`packages/harness/src/systems/pagebridge.ts`) against the page's stored
declarations:

- A query is asked of SQLite's own plan, not read from its text. Every table
  it opens, through a join, a subquery, a CTE or a view, must belong to the
  page's project. The schema, KOS's own tables, other databases and virtual
  tables (pragmas, full-text indexes) are refused. It runs on the read-only
  connection, capped in rows and time.
- A write must name a table the page declared, with only its declared
  columns and operations, and that table must belong to the project.
- A file must be inside the project's folder, and not its page history.

A refusal is answered with a sentence the page can show, and recorded in the
audit log as `page.query`, `page.write` or `page.file`.

## When a page goes wrong

- A page is checked when it is written: its size (400,000 characters at
  most), its libraries, its declarations, that its write targets exist and are
  its own project's, that its headline is read-only, and that it holds
  nothing that would try to leave its frame. A bad page is refused with the
  reason, before anyone sees it.
- An error the page throws is shown above it with **Fix with KOS**, which
  sends the error to the project's chat.
- A page whose frame loads anything a second time (it tried to leave and was
  refused) is removed, with the same button.
