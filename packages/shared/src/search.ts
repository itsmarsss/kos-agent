/**
 * Search everything: what the host's `GET /api/search` answers, and the
 * matching both ends share.
 *
 * A hit carries its words as plain text with the matched stretches named by
 * offsets, never as markup, so a reader draws the marks itself and nothing a
 * chat or a file holds can become an element. The target says where the hit
 * opens: a chat at its message, a file at its line, one claim, one run.
 */

/** The sources the host searches, each named as the palette's prefix for it. */
export const SEARCH_KINDS = ["msg", "text", "memory", "run", "secret"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** Every kind a hit may be: the host's, and Settings, which the dashboard indexes itself. */
export type HitKind = SearchKind | "settings";

export function isSearchKind(value: string): value is SearchKind {
  return (SEARCH_KINDS as readonly string[]).includes(value);
}

/** Where a hit opens. */
export type SearchTarget =
  /** A chat, at the `event`th entry of the transcript its view draws. */
  | { kind: "chat"; id: string; event: number }
  /** A workspace file, at a line counted from 1. */
  | { kind: "file"; path: string; line: number }
  /** One memory claim, by its id. */
  | { kind: "claim"; id: number }
  /** One memory page, by its name. */
  | { kind: "memory-page"; name: string }
  /** A turn or a job's run. */
  | { kind: "run"; id: number }
  /** One tool call. */
  | { kind: "call"; id: number }
  /** A secret's sheet, by its handle: the name, never the value. */
  | { kind: "secret"; handle: string }
  /** A section of Settings. */
  | { kind: "settings"; section: string };

/** Words to show, and the [start, end) stretches of them that matched. */
export interface Snippet {
  text: string;
  marks: [number, number][];
}

export interface SearchHit {
  kind: HitKind;
  /** Unique among the hits of its kind. */
  id: string;
  /** What it is: the chat's title, the file's path, the claim's key. */
  title: string;
  /** A short second word: who said it, the line, the scope. */
  hint?: string;
  snippet: Snippet;
  /** Higher is better, comparable across kinds. */
  score: number;
  /** When it was written or ran, epoch ms, where known. */
  at?: number;
  target: SearchTarget;
}

export interface SearchResults {
  hits: SearchHit[];
  /** Sources that had not answered by the deadline: their hits are missing, not absent. */
  late: SearchKind[];
  /** Sources that stopped at a bound: there may be more than they gave. */
  truncated: SearchKind[];
}

/** How the words were found: the whole query in one place, or every word of it somewhere. */
export type MatchQuality = "phrase" | "words";

export interface TextMatch {
  quality: MatchQuality;
  marks: [number, number][];
}

/** The words of a query, lowered and deduplicated, in the order typed. */
export function queryWords(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every place `needle` occurs in `text`, any case, as offsets into `text` itself. */
function occurrences(text: string, needle: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(new RegExp(escape(needle), "giu"))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Overlapping or touching stretches as one, in order. */
function merged(marks: [number, number][]): [number, number][] {
  const sorted = [...marks].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Whether `text` holds `query`: the whole of it, else every word of it.
 * Undefined when a word is missing. The marks are offsets into `text`.
 */
export function matchText(text: string, query: string): TextMatch | undefined {
  const words = queryWords(query);
  if (words.length === 0) return undefined;
  const phrase = words.length > 1 ? occurrences(text, query.trim().replace(/\s+/g, " ")) : [];
  if (phrase.length > 0) return { quality: "phrase", marks: phrase };
  const each = words.map((w) => occurrences(text, w));
  if (each.some((found) => found.length === 0)) return undefined;
  return { quality: words.length > 1 ? "words" : "phrase", marks: merged(each.flat()) };
}

/** Text on one line: runs of whitespace, newlines among them, as one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** How much of a long text a snippet shows, and how much of it comes before the first match. */
export const SNIPPET_CHARS = 160;
const LEAD_CHARS = 48;

/**
 * The stretch of `text` around its first mark, at most `width` long, with
 * an ellipsis where it was cut and the marks moved to match. A cut is made
 * at a space where one is near, so a word is not shown half.
 */
export function snippetOf(text: string, marks: [number, number][], width = SNIPPET_CHARS): Snippet {
  if (text.length <= width) return { text, marks: marks.filter(([s, e]) => e <= text.length && s < e) };
  const first = marks[0]?.[0] ?? 0;
  let start = Math.max(0, Math.min(first - LEAD_CHARS, text.length - width));
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < first && space - start < 16) start = space + 1;
  }
  let end = Math.min(text.length, start + width);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start && end - space < 16 && space >= (marks[0]?.[1] ?? 0)) end = space;
  }
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const shift = head.length - start;
  const kept = marks
    .filter(([s, e]) => e > start && s < end)
    .map(([s, e]): [number, number] => [Math.max(s, start) + shift, Math.min(e, end) + shift]);
  return { text: `${head}${text.slice(start, end)}${tail}`, marks: kept };
}

/** Single letters' places (as the fuzzy settings index gives them) as stretches. */
export function marksOfLetters(letters: readonly number[]): [number, number][] {
  return merged(letters.map((i): [number, number] => [i, i + 1]));
}
