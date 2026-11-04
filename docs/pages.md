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

The dashboard puts the page in an iframe with `sandbox="allow-scripts"` and
no `allow-same-origin`, so the frame is an opaque origin: it cannot read the
dashboard's DOM, cookies, storage or token, and cannot submit forms, open
windows or navigate the dashboard. Its document begins with a Content
Security Policy that allows no network at all: `connect-src 'none'`, no
external script, style, image or font, inline code and `data:` URLs only.

Before the page's own markup the frame gets:

- KOS's tokens as CSS variables, for the dashboard's theme at that moment,
  and again whenever the owner switches theme;
- `kit.css` and `page.css` from `@kos/kit`, so plain markup and the kit's
  classes read as KOS;
- the `window.kos` bridge;
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
  its own project's, and that its headline is read-only. A bad page is
  refused with the reason, before anyone sees it.
- An error the page throws is shown above it with **Fix with KOS**, which
  sends the error to the project's chat.
- A page that sends its frame to another address is stopped and its frame
  removed.

**A known limit.** A sandboxed frame may still navigate itself, and the shell
can only see that it did after the fact, so a page could carry what it read
into the address it navigates to before it is stopped. What it could have read
is only its own project's data, and only a page the agent wrote can try.
