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

/** Values shorter than this are not scanned for: they would match ordinary text. */
export const MIN_SCANNED = 6;

/** What a found value is replaced with. */
export function scrubbedLabel(name: string): string {
  return `[secret ${name}]`;
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
}

interface Match {
  start: number;
  end: number;
  name: string;
}

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
        found.push({ start: offset - needle.text.length, end: offset, name: needle.name });
      }
    }
    return found;
  }

  /** `text` with each found needle replaced, and which secrets were found how often. */
  replace(text: string): { text: string; hits: Map<string, number> } {
    const hits = new Map<string, number>();
    const found = this.find(text).sort((a, b) => a.start - b.start || b.end - a.end);
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
  /** The longest needle, so a stream can hold back enough to never split one. */
  readonly longest: number;

  constructor(
    values: Iterable<[name: string, value: string]>,
    private readonly onHit: (name: string, count: number) => void = () => undefined,
  ) {
    const needles: Needle[] = [];
    for (const [name, value] of values) {
      for (const text of needlesOf(value)) needles.push({ text, name });
    }
    this.automaton = needles.length > 0 ? new Automaton(needles) : undefined;
    this.longest = Math.max(0, ...needles.map((needle) => needle.text.length));
  }

  /** `text` with every known value, in any form looked for, replaced by `[secret <name>]`. */
  scrub(text: string): string {
    if (!this.automaton || text.length < MIN_SCANNED) return text;
    const { text: out, hits } = this.automaton.replace(text);
    for (const [name, count] of hits) this.onHit(name, count);
    return out;
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
