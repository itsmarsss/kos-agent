/**
 * Typed blocks: a fenced block whose info string is `kos:<kind>`.
 *
 * KOS wrote its email and message drafts as loose markdown, and the owner
 * copied them out of prose. A typed block says what a thing is, so every
 * surface can draw it as that thing: a draft with its fields and a Copy, an
 * event with an .ics, a checklist that ticks. The grammar is in
 * docs/blocks.md and is the contract; this is one reading of it.
 *
 *     ```kos:email
 *     to: sam@example.com
 *     subject: Saturday at 4
 *     ---
 *     Hi Sam, ...
 *     ```
 *
 * Header lines are `key: value`, a key lowercase and repeatable (a list), a
 * value one line. A line `---` ends the header; the body after it is kept
 * verbatim. Either half may be empty. A block whose header is not all
 * `key: value` lines is malformed, and a renderer draws it as the code block
 * it would otherwise have been, so no text is ever lost.
 */

/** A fence: the backtick run that opened it, its info string, the lines inside, and the line after it. */
export interface Fence {
  /** How many backticks opened it; only a run at least as long closes it. */
  ticks: number;
  /** Everything after the backticks, trimmed: `ts title="x"`. */
  info: string;
  /** Its first word: the language, or `kos:<kind>`. */
  lang: string;
  body: string[];
  /** The index of the first line after the fence. */
  next: number;
  /** False when the input ended first: a reply still streaming, or one cut short. */
  closed: boolean;
}

/** A typed block, read. */
export interface KosBlock {
  kind: string;
  /** The header, in order; a key that repeats is a list. */
  fields: Array<[key: string, value: string]>;
  body: string;
}

/** Any info string without a backtick, as CommonMark has it: ```ts title="x" and ```js {1,3} are fences. */
const OPEN = /^\s*(`{3,})([^`]*)$/;
const KOS_INFO = /^kos:([a-z][a-z0-9-]*)$/i;
const HEADER_LINE = /^([A-Za-z][\w-]*):(.*)$/;
const RULE = /^\s*---\s*$/;

/**
 * The fence opening at `lines[i]`, read to its close, or null when the line
 * opens none. A run of N backticks closes only on a line of at least N and
 * nothing else, so a block written with four holds a three-backtick fence
 * in its body, as CommonMark has it; each line loses up to as many spaces as
 * the opener is indented by, so a channel says an indented block as a view
 * draws it.
 */
export function fenceAt(lines: readonly string[], i: number): Fence | null {
  const open = OPEN.exec(lines[i] ?? "");
  if (!open) return null;
  const ticks = (open[1] ?? "").length;
  const close = new RegExp(`^\\s*\`{${ticks},}\\s*$`);
  // A fence indented under a list item: its lines lose as many spaces as its opener has, as CommonMark has it.
  const indent = new RegExp(`^ {0,${/^ */.exec(lines[i] ?? "")?.[0].length ?? 0}}`);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j] ?? "")) {
    body.push((lines[j] ?? "").replace(indent, ""));
    j++;
  }
  const closed = j < lines.length;
  const info = (open[2] ?? "").trim();
  return { ticks, info, lang: info.split(/\s+/)[0] ?? "", body, next: closed ? j + 1 : j, closed };
}

/** The kind an info string's first word names, `kos:email` as "email"; nothing for any other fence. */
export function kindOfInfo(info: string): string | undefined {
  return KOS_INFO.exec(info.trim().split(/\s+/)[0] ?? "")?.[1]?.toLowerCase();
}

/** A fence's lines as a typed block, or null when its info is not `kos:<kind>` or its header is malformed. */
export function parseBlock(info: string, lines: readonly string[]): KosBlock | null {
  const kind = kindOfInfo(info);
  if (!kind) return null;
  const rule = lines.findIndex((l) => RULE.test(l));
  const head = rule === -1 ? lines : lines.slice(0, rule);
  const fields: Array<[string, string]> = [];
  for (const line of head) {
    if (line.trim() === "") continue;
    const m = HEADER_LINE.exec(line.trim());
    if (!m) return null;
    fields.push([(m[1] ?? "").toLowerCase(), (m[2] ?? "").trim()]);
  }
  const body = rule === -1 ? [] : lines.slice(rule + 1);
  return { kind, fields, body: trimBlankEnds(body).join("\n") };
}

/** A block's lines with the blank lines at either end taken off; the ones between are the body's. */
function trimBlankEnds(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

/** Every value a key has, in order; none when it is absent or empty. */
export function valuesOf(block: KosBlock, key: string): string[] {
  return block.fields.filter(([k, v]) => k === key && v.trim() !== "").map(([, v]) => v.trim());
}

/** A key's first value. */
export function valueOf(block: KosBlock, key: string): string | undefined {
  return valuesOf(block, key)[0];
}

/** A text's typed blocks, in order, as the renderers read them. */
export function blocksIn(text: string): KosBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: KosBlock[] = [];
  for (let i = 0; i < lines.length; ) {
    const fence = fenceAt(lines, i);
    if (!fence) {
      i++;
      continue;
    }
    const block = parseBlock(fence.info, fence.body);
    if (block) out.push(block);
    i = fence.next;
  }
  return out;
}

/**
 * The text with each well-formed typed block replaced by what `say` makes of
 * it, every other line kept as written: a surface with no block view (a
 * text message, Discord) gets the block's plain words in its place.
 */
export function replaceBlocks(text: string, say: (block: KosBlock) => string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const fence = fenceAt(lines, i);
    if (!fence) {
      out.push(lines[i] ?? "");
      i++;
      continue;
    }
    const block = parseBlock(fence.info, fence.body);
    out.push(...(block ? say(block).split("\n") : lines.slice(i, fence.next)));
    i = fence.next;
  }
  return out.join("\n");
}
