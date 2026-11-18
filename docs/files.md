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
| xlsx, xlsm, xlsb, xls, ods, numbers | SheetJS 0.20.3 (Apache-2.0), values as the file formats them; no formulas run, no macros read | anywhere |
| csv, tsv | KOS's own, RFC 4180, values never reinterpreted | anywhere |
| pptx, pptm, ppsx, potx | KOS's own: each slide with what it inherits from its layout and master | anywhere |
| pages, key | the preview the file keeps for Finder | anywhere |
| doc, rtf, odt | macOS's textutil in a sandbox (no network, no writes), then cleaned | a Mac |
| ppt, odp | QuickLook's picture of the first slide | a Mac |

The bounds: a file over 30 MB (12 MB for CSV) is not converted; a zip is
inflated under caps (64 MB an entry, 160 MB in all) before anything reads
it, so a zip bomb is refused; a sheet shows at most 2,000 rows, 100
columns and 400,000 cells; a deck 200 slides; pictures are inlined only
as raster data URIs, at most 6 MB each. Conversion runs in a worker of its
own with a 512 MB heap and a 20 second clock; textutil has the same
clock. Every document's HTML leaves the server through one allow-list
(`files/viewer/sanitize.ts`): no script, handler, frame, form, link
target, external picture or fetching CSS. The dashboard then draws it in
an `<iframe sandbox>` with a policy of `default-src 'none'; img-src
data:; style-src 'unsafe-inline'`. A view is kept in memory by path,
modified time and size.

## Thumbnails and media

- `GET /api/file/thumb?path=&size=128|256|512`: a PNG or JPEG of a
  document's first page or a video's frame, or 404 when this host can
  draw none. iWork files use their own preview anywhere; on a Mac,
  QuickLook draws PDFs, Office files, iWork files, videos, HEIC, TIFF
  and PSD, eight seconds at most, two at a time. Kept under
  `.kos/cache/thumbs` by path, time, size and edge, a miss included.
- `GET /api/file/media?path=`: sound and video for a player (mp3, m4a,
  aac, wav, ogg, flac, mp4, m4v, webm, mov), with `Range` answered by a
  206, 16 MB a piece.

## Facts, search and recents

- `GET /api/files/info?path=`: name, kind, size, created and modified
  times, a folder's item count, a picture's pixels, a PDF's pages, an
  Office file's pages, slides or sheets, and the project it is in.
- `GET /api/files/search?path=&q=&contents=1`: names holding `q` under
  `path` (300 at most), or with `contents=1` text files holding it, each
  with the first line that matched (search.grep's own reader). Hidden
  names, links and tool caches are not walked; 30,000 entries at most.
- `GET /api/files/recents`: the 60 files changed most lately.

## The trash

- `POST /api/files/trash {path}`: moves the file or folder into
  `.kos/trash/files/<id>/` beside a note of where it was.
- `GET /api/files/trash`: what is there, the latest first.
- `POST /api/files/restore {id}`: puts it back where it was, as "name
  (2)" when something took its place.
- `POST /api/files/empty-trash {confirm: true, ids?}`: deletes for good,
  the items named or all of them; without `confirm` it refuses. It is the
  only hard delete the file manager has.
