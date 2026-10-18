# The UI language

One dashboard, built from a few parts used the same way everywhere. This is
the list of parts, the rules for using them, and the audit that produced it.

## Parts

All in `packages/ui/src/kit.tsx` unless named otherwise.

- **Page head** (`PageHead`): the page's name, one line on what it is for,
  a search box where there is something to search, and the actions with
  the primary one last. Every list page opens this way.
- **Tabs**: the pill bar at the top of Memory and Runs. One row, the current
  tab filled.
- **Card**: a boxed section with a small uppercase title, an optional count,
  a Pill or an action at its right, then its body. Columns are stacks of
  cards: the blob page, the project page. A page-level panel on the
  Overview is the same box with a bold title, since there it is the page's
  own content rather than a section of something.
- **Field**: a label, the control, then one line under it: a hint on what to
  put there, or an error in the danger colour when it cannot be sent as it
  is. Labels are sentence case, small and semibold. `required` puts a red
  mark on the label, and the form's submit stays off until every required
  field is filled. Several controls under one label (swatches, a tool
  list) use `group`, so the label is a heading and not a `<label>`.
- **Pill**: a state in a word, coloured by what it means: `ok` on, `warn`
  paused, `danger` failed, `accent` working, `muted` anything else.
- **Tag**: a fact in a word or two: a tool family (mono), a memory scope, a
  model class, a type. Never a button. A filter chip that can be pressed
  is `.chip`, which is a different thing and looks like one.
- **SchedulePicker** (`SchedulePicker.tsx`): when something runs, as
  choices (daily, weekdays, the days you pick, hourly, minutes, monthly)
  with the line it writes read back in words, and the line itself to edit
  for anything the choices do not cover. Every place a schedule is set uses
  it; nowhere asks for five fields cold.
- **Empty**: what a list or panel says when there is nothing in it: a title
  and a line in a dashed box. A blank reads as broken; an answer does not.
- **Buttons**: `.btn`; `.btn--primary` once per form, last; `.btn--sm`
  inside cards and rows; `.btn--ghost` for the quiet choice; a delete is
  `.btn--danger-ghost` and becomes `.btn--danger` once pressed, with a line
  saying what goes.
- **Uppercase** is for section and card titles and table column heads, and
  nothing else. Form labels are not uppercase.
- **Faces** (`Face.tsx`): a blob's or KOS's face, at 16 to 18 in rows, 26
  in list rows, 44 to 72 in a head. Its hue is the column's accent on the
  blob page (`--blob-h`).

## Audit, 2026-10-18

What a walk through every page found, and where each item stands.

| Where | What was off | Now |
| --- | --- | --- |
| Blob page, right column | Plain lines, no hierarchy | Hero, cards, pills, tags (#355); the model for the rest |
| New blob, New project, New schedule, Configure, Hand off | Labels in two styles, no sign of what is required | One `Field`, required marks, errors in place of hints |
| Project page, right column | Bare uppercase heads with no box; a plain head | Cards, and a hero like the blob page's, in the project's own colour |
| Inbox, nothing waiting | Its own empty state | `Empty` |
| Files, a file's header | Icon, name, meta and buttons spread across the width | Grouped left, actions right (#357) |
| Face colour | A hue slider | Swatches and an in-page picker (#352, #354, #358) |
| Blobs index, Overview Blobs panel | Markdown marks in the last-said line | Stripped |
| Settings | Its own `Field` with larger labels, and uppercase labels inside Models | On the kit's label and hint |
| Overview panels | Bold heads with "All →" | Kept: the page-level card style |
| Memory, Runs, Projects | List pages: filter chips, tables, a card each | Consistent among themselves; chip stays the pressable one |
| Chats | Its own rail and landing | By design; not a list page |

## Next

The Overview panel head as the card's bold variant; any remaining chip that
cannot be pressed becomes a `Tag`; the Memory and Runs tab bar as one
component.
