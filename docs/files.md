# Files: viewers and the file manager's routes

What the dashboard's file manager and KOS for iPhone ask the server for,
beyond a folder's listing (`GET /api/files`) and a file (`GET /api/file`).
Every path is workspace-relative and goes through the jail
(`resolvePath`): `..`, a symbolic link anywhere on the way, or a path out
of the workspace is refused with a 400. Writes also refuse the
workspace's own files (`.kos`, `kos.sqlite`, `profile.json`, `mcp.json`,
`daemon.json`, `locks`) and its top-level folders.

## Office views

`GET /api/file/office?path=` answers a view of the file as JSON, served
with `x-content-type-options: nosniff` and `content-security-policy:
default-src 'none'; sandbox`. Its shape is `OfficeView` in
`shared/src/officeview.ts`:

| kind | what | fields |
| --- | --- | --- |
| `doc` | a document as cleaned HTML | `html` |
| `sheet` | a workbook | `sheets`: `name`, `rows` (cells `{v, t}` or null; `t` is n, b, e, d or s), `cols`, `totalRows`, `totalCols`, `widths`, `merges` |
| `slides` | a deck, drawn from positioned shapes | `aspect`, `slides`: `title`, `background`, `shapes` (text, picture, box, table, each at fractions of the slide), `notes` |
| `picture` | a picture of the first page or slide | `src` (a data URI) |

Each carries `format` and `notes`: what the view leaves out, in words to
show ("Showing the first 2,000 of 9,000 rows.").

How each format is read:

| format | reader | where |
| --- | --- | --- |
| docx, docm, dotx | KOS's own: the document XML to HTML (headings, runs, lists, tables with merges, pictures inline) | anywhere |
| xlsx, xlsm, xlsb, xls, ods, numbers | SheetJS 0.20.3 (Apache-2.0, its tarball pinned by sha512 in the lockfile), values as the file formats them; no formulas run, no macros read | anywhere |
| csv, tsv | KOS's own, RFC 4180, values never reinterpreted | anywhere |
| pptx, pptm, ppsx, potx | KOS's own: each slide with what it inherits from its layout and master | anywhere |
| pages, key | the preview the file keeps for Finder | anywhere |
| doc, rtf, odt | macOS's textutil in a sandbox (no network, no writes, no reads under /Users or the home folder but its own copy, nothing run but itself), then cleaned | a Mac |
| ppt, odp | QuickLook's picture of the first slide | a Mac |

The bounds: a file over 30 MB (12 MB for CSV) is not converted; its bytes
are sniffed (zip, Office 97, text) and refused when they disagree with its
name; any zip, whatever its name, is inflated under caps (64 MB an entry,
160 MB in all, checked against what the directory declares before each
entry and against what was inflated after) before anything reads it, so a
zip bomb is refused; a sheet shows at most 2,000 rows, 100
columns and 400,000 cells; a deck 200 slides; pictures are inlined only
as raster data URIs, at most 6 MB each. Conversion runs in a child process of its
own (`files/viewer/child.ts`), two at a time, with a 512 MB heap, a 20
second clock and a 1 GB ceiling on its whole resident size, buffers
included, watched from outside; textutil has the same clock. Every document's HTML leaves the server through one allow-list
(`files/viewer/sanitize.ts`): no script, handler, frame, form, link
target, external picture or fetching CSS. The dashboard then draws it in
an `<iframe sandbox>` with a policy of `default-src 'none'; img-src
data:; style-src 'unsafe-inline'`. A view is kept in memory by path,
modified time and size.

## Thumbnails and media

- `GET /api/file/thumb?path=&size=128|256|512`: a JPEG of a Pages,
  Keynote or Numbers file's own preview, or of a HEIC, HEIF, AVIF or TIFF
  picture (sips in its sandbox on a Mac, the pixels worker elsewhere), or
  404. Documents and videos get their kind's mark: QuickLook will not run
  inside a sandbox, so it is used only for an old deck's first slide.
  Kept under `.kos/cache/thumbs` by path, time, size and edge, a miss
  included.
- `GET /api/file/media?path=`: sound and video for a player (mp3, m4a,
  aac, wav, ogg, flac, mp4, m4v, webm, mov), streamed from disk: the
  whole file with a 200, one asked range with a 206, a range that cannot
  be served with a 416.

## Facts, search and recents

- `GET /api/files/info?path=`: name, kind, size, created and modified
  times, a folder's item count, a picture's pixels, a PDF's pages, an
  Office file's pages, slides or sheets, and the project it is in.
- `GET /api/files/search?path=&q=&contents=1`: names holding `q` under
  `path` (300 at most), or with `contents=1` text files holding it, each
  with the first line that matched (search.grep's own reader, three
  seconds at most). Hidden names, links, tool caches and the workspace's
  own files are not walked; 30,000 entries at most.
- `GET /api/files/recents`: the 60 files changed most lately.

## The trash

- `POST /api/files/trash {path}`: moves the file or folder into
  `.kos/trash/files/<id>/`, the note of where it was written first.

Every write (rename, copy, new folder, trash, restore) tests the path as
the jail resolved it, so `./kos.sqlite`, `projects//x` and `./.kos/x` are
what they are, not what they look like.
- `GET /api/files/trash`: what is there, the latest first.
- `POST /api/files/restore {id}`: puts it back where it was, as "name
  (2)" when something took its place.
- `POST /api/files/empty-trash {confirm: true, ids?}`: deletes for good,
  the items named or all of them; without `confirm` it refuses. It is the
  only hard delete the file manager has.
