/**
 * A markdown list, for every surface that draws one.
 *
 * Both renderers read a list a line at a time, and both flattened it: an
 * indented bullet became a sibling, and a numbered step's sub-points
 * restarted the numbering. A list item is a small document of its own (a
 * line of words, the bullets under it, a code block, a formula), so this
 * finds where each item starts and ends and hands back its lines, indent
 * taken off, for the renderer to read as blocks like any other markdown;
 * a list inside an item is found again there. A blank line between items is
 * a loose list, not its end (ending it there drew a spaced-out list as
 * "1. 1. 1.").
 */

export interface MdList {
  ordered: boolean;
  /** The first number of an ordered list, as written. */
  start: number;
  items: MdListItem[];
}

export interface MdListItem {
  /** The item as markdown: its first line, then what is indented under it, indent removed. */
  body: string;
}

/** A marker: its indent, the marker, the spaces after it, the rest. The `s` flag keeps a line separator inside the item. */
const MARKER = /^([ \t]*)([-*+]|(\d{1,9})[.)])([ \t]+)(.*)$/s;

/** Fences that hold lines however they are indented, until they close. */
const FENCES: Array<[RegExp, RegExp]> = [
  [/^\s*```/, /^\s*```\s*$/],
  [/^\s*\$\$\s*$/, /\$\$\s*$/],
  [/^\s*\\\[\s*$/, /\\\]\s*$/],
];

/** How far in a line starts, a tab counting as four. */
function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

/** The line with up to `n` columns of its indent taken off. */
function dedent(line: string, n: number): string {
  let cut = 0;
  let col = 0;
  while (cut < line.length && col < n) {
    const ch = line[cut];
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4;
    else break;
    cut++;
  }
  return line.slice(cut);
}

interface Marker {
  indent: number;
  ordered: boolean;
  number: number;
  /** Where the item's words start: under them is inside it. */
  content: number;
  text: string;
}

function markerOf(line: string): Marker | undefined {
  const m = MARKER.exec(line);
  if (!m) return undefined;
  const indent = indentOf(line);
  const gap = (m[4] ?? " ").replace(/\t/g, "    ").length;
  // Code indented past the marker is not its words; the words start one space in.
  const content = indent + (m[2] ?? "").length + (gap > 4 ? 1 : gap);
  return { indent, ordered: m[3] !== undefined, number: Number(m[3] ?? 1), content, text: m[5] ?? "" };
}

/** Whether a line starts a list. */
export function startsList(line: string): boolean {
  return MARKER.test(line);
}

/**
 * The list that starts at line i, and the line after it; nothing when line
 * i is not a list item. An item takes every line indented past the list's
 * markers (a deeper marker is a list inside it), a fence it opens until the
 * fence closes, and blank lines that have more of it after them. The list
 * ends at an unindented line that is not an item, or at an item of the other
 * kind. A number a few columns shallower is a sibling: "9." over "10.".
 */
export function listAt(lines: string[], i: number): { list: MdList; next: number } | undefined {
  const first = markerOf(lines[i] ?? "");
  if (!first) return undefined;
  const list: MdList = { ordered: first.ordered, start: first.number, items: [] };
  const sibling = (m: Marker): boolean => m.indent <= first.indent && m.indent >= first.indent - 3 && m.ordered === first.ordered;
  let body: string[] = [];
  let content = first.content;
  const close = (): void => {
    if (body.length) list.items.push({ body: body.join("\n").replace(/\n+$/, "") });
  };

  /**
   * After a line that opens a fence, the lines it holds, up to and with the
   * one that closes it. They lose only the indent they all share, up to the
   * item's: code written flush left under an indented fence keeps its shape.
   */
  const holdFence = (opened: string, from: number): number => {
    const fence = FENCES.find(([open]) => open.test(opened));
    if (!fence) return from;
    let k = from;
    const held: string[] = [];
    let closing: string | undefined;
    while (k < lines.length) {
      const line = lines[k] ?? "";
      k++;
      if (fence[1].test(line)) {
        closing = line;
        break;
      }
      held.push(line);
    }
    const shared = Math.min(content, ...held.filter((l) => l.trim() !== "").map(indentOf));
    body.push(...held.map((l) => dedent(l, shared)));
    if (closing !== undefined) body.push(dedent(closing, content));
    return k;
  };

  let j = i;
  while (j < lines.length) {
    const line = lines[j] ?? "";
    const marker = markerOf(line);
    if (j === i || (marker && sibling(marker))) {
      close();
      const m = j === i ? first : marker!;
      body = [m.text];
      content = m.content;
      j = holdFence(m.text, j + 1);
      continue;
    }
    if (line.trim() === "") {
      let k = j;
      while (k < lines.length && (lines[k] ?? "").trim() === "") k++;
      const after = lines[k] ?? "";
      const more = markerOf(after);
      if (k >= lines.length || !(indentOf(after) > first.indent || (more && sibling(more)))) break;
      if (!(more && sibling(more))) body.push("");
      j = k;
      continue;
    }
    if (indentOf(line) <= first.indent) break;
    // Inside the item. A fence it opens holds its lines however they sit.
    const own = dedent(line, content);
    body.push(own);
    j = holdFence(own, j + 1);
  }
  close();
  return { list, next: j };
}
