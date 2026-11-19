/**
 * The second line: a secret's value taken out of text before it is kept or
 * shown.
 *
 * The first line is that a value only ever enters a tool through a declared
 * slot. Whatever a call sends can still come back in what it answers (an
 * API that echoes its key, a page that prints a header), so every result,
 * and every progress event, passes through here before the model, a reader
 * or the database sees it.
 *
 * A value is looked for as it is and as the common encodings write it, so a
 * key that comes back JSON-escaped, URL-encoded, in base64 or in hex is still
 * caught. Short values are not looked for at all: below six characters a
 * match says more about the text than the secret.
 */

import { CARD_SEP } from "./shapes.js";

/** Values shorter than this are not scanned for: they would match ordinary text. */
export const MIN_SCANNED = 6;

/** Past this, a stream holds back only enough for a value as it is or JSON-escaped, not its longer encodings. */
export const STREAM_REACH = 256;

/** What a found value is replaced with; a card number keeps its last four digits, as a receipt does. */
export function scrubbedLabel(name: string, last4?: string): string {
  return last4 ? `[secret ${name} ••${last4}]` : `[secret ${name}]`;
}

/**
 * How a value is looked for: `exact` as it is and encoded; `digits` (a card
 * number) by its digits alone, whatever spaces, dashes or dots run between;
 * `code` (a one-time code) as exact, but as it is only where no letter or
 * digit stands beside it, so a six-digit code is not found inside a
 * timestamp or an id.
 */
export type ScanMode = "exact" | "digits" | "code";

/** A watched value: its name in a label, the value, and how it is looked for (exact when left out). */
export type Watched = [name: string, value: string] | [name: string, value: string, mode: ScanMode];

/** The fewest digits a digits-only value has before it is looked for: shorter runs are dates and amounts. */
const DIGITS_MIN = 12;

/**
 * A number written with up to three separators between any two of its
 * digits (CARD_SEP: spaces, tabs, dashes, dots, plus, underscore, slash,
 * no-break spaces, their URL encodings), never inside a longer number.
 */
function digitsPattern(digits: string): RegExp {
  return new RegExp(`(?<!\\d)${[...digits].join(`${CARD_SEP}{0,3}`)}(?!\\d)`, "g");
}

/**
 * Base64 of `value` as it appears inside a longer encoding, at each of the
 * three byte alignments: only the characters `value`'s own bits decide, so
 * the match holds whatever came before or after it.
 */
function base64Runs(value: Buffer, alphabet: "base64" | "base64url"): string[] {
  const runs: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), value]).toString(alphabet);
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + value.length) * 8) / 6);
    runs.push(encoded.slice(start, end));
  }
  return runs;
}

/** Every way `value` is looked for: itself and how the common encodings write it. */
export function needlesOf(value: string): string[] {
  if (value.length < MIN_SCANNED) return [];
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  const json = JSON.stringify(value).slice(1, -1);
  const uri = encodeURIComponent(value);
  const forms = [
    value,
    json,
    // PHP and some JSON writers escape the slash too.
    json.replaceAll("/", "\\/"),
    uri,
    // RFC 3986 strict: the sub-delims encodeURIComponent leaves alone.
    uri.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    // Percent escapes in lowercase hex, as some encoders write them.
    uri.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    new URLSearchParams({ v: value }).toString().slice(2),
    ...base64Runs(bytes, "base64"),
    ...base64Runs(bytes, "base64url"),
    hex,
    hex.toUpperCase(),
  ];
  return [...new Set(forms)].filter((form) => form.length >= MIN_SCANNED);
}

interface State {
  next: Map<string, number>;
  fail: number;
  /** The needle ending here, by index, if one does. */
  ends?: number;
  /** The nearest state down the fail chain where a needle ends. */
  out: number;
}

interface Needle {
  text: string;
  name: string;
  /** Found only where no letter or digit stands beside it. */
  bounded?: boolean;
}

interface Match {
  start: number;
  end: number;
  name: string;
  bounded?: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Aho-Corasick over every needle, so a long result is read once however many
 * secrets there are. Overlapping matches resolve leftmost, then longest.
 */
class Automaton {
  private readonly states: State[] = [{ next: new Map(), fail: 0, out: -1 }];

  constructor(private readonly needles: Needle[]) {
    needles.forEach((needle, index) => this.add(needle.text, index));
    this.link();
  }

  private add(text: string, index: number): void {
    let at = 0;
    for (const ch of text) {
      let to = this.states[at]!.next.get(ch);
      if (to === undefined) {
        to = this.states.push({ next: new Map(), fail: 0, out: -1 }) - 1;
        this.states[at]!.next.set(ch, to);
      }
      at = to;
    }
    // A value shared by two secrets keeps the first name.
    this.states[at]!.ends ??= index;
  }

  private link(): void {
    const queue: number[] = [...this.states[0]!.next.values()];
    while (queue.length > 0) {
      const at = queue.shift()!;
      const state = this.states[at]!;
      for (const [ch, to] of state.next) {
        let fail = state.fail;
        while (fail !== 0 && !this.states[fail]!.next.has(ch)) fail = this.states[fail]!.fail;
        const back = this.states[fail]!.next.get(ch);
        const child = this.states[to]!;
        child.fail = back !== undefined && back !== to ? back : 0;
        const below = this.states[child.fail]!;
        child.out = below.ends !== undefined ? child.fail : below.out;
        queue.push(to);
      }
    }
  }

  /** Every needle found in `text`, by UTF-16 offsets. */
  private find(text: string): Match[] {
    const found: Match[] = [];
    let at = 0;
    let offset = 0;
    for (const ch of text) {
      offset += ch.length;
      while (at !== 0 && !this.states[at]!.next.has(ch)) at = this.states[at]!.fail;
      at = this.states[at]!.next.get(ch) ?? 0;
      for (let hit = this.states[at]!.ends !== undefined ? at : this.states[at]!.out; hit > 0; hit = this.states[hit]!.out) {
        const needle = this.needles[this.states[hit]!.ends!]!;
        found.push({ start: offset - needle.text.length, end: offset, name: needle.name, ...(needle.bounded ? { bounded: true } : {}) });
      }
    }
    return found;
  }

  /** `text` with each found needle replaced, and which secrets were found how often. */
  replace(text: string): { text: string; hits: Map<string, number> } {
    const hits = new Map<string, number>();
    const alone = (m: Match): boolean => !m.bounded || !(WORD_CHAR.test(text[m.start - 1] ?? "") || WORD_CHAR.test(text[m.end] ?? ""));
    const found = this.find(text)
      .filter(alone)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    if (found.length === 0) return { text, hits };
    let out = "";
    let from = 0;
    for (const match of found) {
      // Overlapping values are one run: the label already said covers it, and none of the rest shows.
      if (match.start < from) {
        from = Math.max(from, match.end);
        continue;
      }
      out += text.slice(from, match.start) + scrubbedLabel(match.name);
      from = match.end;
      hits.set(match.name, (hits.get(match.name) ?? 0) + 1);
    }
    return { text: out + text.slice(from), hits };
  }
}

/**
 * Secret values taken out of text. Built once from a set of named values;
 * a change to the secrets builds a new one.
 */
export class Scrubber {
  private readonly automaton: Automaton | undefined;
  /**
   * How much of a stream to hold back so no value is split between two of
   * its pieces: one less than the longest needle, an encoded form counted
   * only up to STREAM_REACH, a value as it is or JSON-escaped in full.
   */
  readonly holdBack: number;
  /** Card numbers, each found by its digits however they are spaced. */
  private readonly numbers: { name: string; pattern: RegExp; last4: string }[] = [];

  constructor(
    values: Iterable<Watched>,
    private readonly onHit: (name: string, count: number) => void = () => undefined,
  ) {
    const needles: Needle[] = [];
    let reach = 0;
    for (const [name, value, mode = "exact"] of values) {
      if (mode === "digits") {
        const digits = value.replace(/\D/g, "");
        if (digits.length < DIGITS_MIN) continue;
        this.numbers.push({ name, pattern: digitsPattern(digits), last4: digits.slice(-4) });
        reach = Math.max(reach, digits.length * 19);
        continue;
      }
      const plain = [value, JSON.stringify(value).slice(1, -1)];
      for (const text of needlesOf(value)) {
        needles.push({ text, name, ...(mode === "code" && text === value ? { bounded: true } : {}) });
        reach = Math.max(reach, plain.includes(text) ? text.length : Math.min(text.length, STREAM_REACH));
      }
    }
    this.automaton = needles.length > 0 ? new Automaton(needles) : undefined;
    this.holdBack = Math.max(0, reach - 1);
  }

  /** `text` with every known value, in any form looked for, replaced by `[secret <name>]`. */
  scrub(text: string): string {
    return this.found(text).text;
  }

  /** `text` scrubbed, and which secrets were found in it how often. */
  found(text: string): { text: string; hits: Map<string, number> } {
    const hits = new Map<string, number>();
    if (text.length < MIN_SCANNED) return { text, hits };
    let out = text;
    for (const { name, pattern, last4 } of this.numbers) {
      out = out.replace(pattern, () => {
        hits.set(name, (hits.get(name) ?? 0) + 1);
        return scrubbedLabel(name, last4);
      });
    }
    if (this.automaton) {
      const replaced = this.automaton.replace(out);
      out = replaced.text;
      for (const [name, count] of replaced.hits) hits.set(name, (hits.get(name) ?? 0) + count);
    }
    for (const [name, count] of hits) this.onHit(name, count);
    return { text: out, hits };
  }
}

/** Every string in a value scrubbed, objects and arrays walked; the value itself when nothing changed. */
export function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) {
    const out = value.map((item: unknown) => scrubDeep(item, scrub));
    return (out.some((item, i) => item !== value[i]) ? out : value) as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = scrubDeep(item, scrub);
      if (out[key] !== item) changed = true;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
