/**
 * A markdown list, nesting and all, for every surface that draws one.
 *
 * Both renderers read a list a line at a time, and both flattened it: an
 * indented bullet became a sibling, and a numbered step's sub-points
 * restarted the numbering. A list is a tree, so it is read as one here:
 * an item deeper than the list's own marker opens a list under the item
 * before it, an indented line that is not a marker continues that item,
 * and a blank line between items is a loose list, not its end (ending it
 * there drew a spaced-out list as "1. 1. 1.").
 */

export interface MdList {
  ordered: boolean;
  /** The first number of an ordered list, as written. */
  start: number;
  items: MdListItem[];
}

export interface MdListItem {
  /** The item's own lines, joined by newlines. */
  text: string;
  /** Lists nested under it. */
  lists: MdList[];
}

const MARKER = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/;

/** How far in a line starts, a tab counting as four. */
function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

interface Marker {
  indent: number;
  ordered: boolean;
  number: number;
  text: string;
}

function markerOf(line: string): Marker | undefined {
  const m = MARKER.exec(line);
  if (!m) return undefined;
  return { indent: indentOf(line), ordered: m[2] !== undefined, number: Number(m[2] ?? 1), text: m[3] ?? "" };
}

/** Whether line i starts a list. */
export function startsList(line: string): boolean {
  return MARKER.test(line);
}

/**
 * The list that starts at line i, and the line after it; nothing when line
 * i is not a list item. It ends at a line that is neither an item, an
 * indented continuation nor a blank between items, or at an item of the
 * other kind at its own depth.
 */
export function listAt(lines: string[], i: number): { list: MdList; next: number } | undefined {
  const first = markerOf(lines[i] ?? "");
  if (!first) return undefined;
  return readList(lines, i, first);
}

function readList(lines: string[], i: number, first: Marker): { list: MdList; next: number } {
  const list: MdList = { ordered: first.ordered, start: first.number, items: [] };
  let j = i;
  while (j < lines.length) {
    const line = lines[j] ?? "";
    const marker = markerOf(line);
    if (marker && marker.indent <= first.indent) {
      // Shallower than this list belongs to the list above; the other kind at this depth is a new list.
      if (marker.indent < first.indent || marker.ordered !== first.ordered) break;
      list.items.push({ text: marker.text, lists: [] });
      j++;
      continue;
    }
    const item = list.items.at(-1);
    if (!item) break;
    if (marker) {
      const nested = readList(lines, j, marker);
      item.lists.push(nested.list);
      j = nested.next;
      continue;
    }
    if (line.trim() === "") {
      // A blank line goes on when what follows is more of this list.
      let k = j;
      while (k < lines.length && (lines[k] ?? "").trim() === "") k++;
      const after = lines[k] ?? "";
      const more = markerOf(after);
      const continues = more ? more.indent > first.indent || (more.indent === first.indent && more.ordered === first.ordered) : indentOf(after) > first.indent && after.trim() !== "";
      if (!continues) break;
      j = k;
      continue;
    }
    // An indented line that is not a marker carries on the item above.
    if (indentOf(line) > first.indent) {
      item.text += `\n${line.trim()}`;
      j++;
      continue;
    }
    break;
  }
  return { list, next: j };
}
