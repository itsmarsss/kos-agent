import { createHmac } from "node:crypto";

import { needlesOf, scrubbedLabel, type Watched } from "./scrub.js";

/**
 * A scrub index: what the scrubber needs to find the vault's values while
 * the vault is locked, without holding them.
 *
 * For every value and every encoding the scrubber looks for, it keeps the
 * length and an HMAC-SHA256 under a scrub key of its own (a 0600 file beside
 * the vault, never the vault's key), plus a short keyed rolling hash that
 * says which windows of a text are worth an HMAC. Text is scanned in windows
 * of each length kept.
 *
 * The trade: anyone holding both the index and the scrub key can test a
 * guess at a value offline, as fast as HMAC runs. That is cheap for a short
 * or common password; a passphrase vault's values are otherwise only
 * reachable through scrypt. Card numbers are left out, since their small
 * space (a known prefix, a Luhn digit, a hint's last four) makes such a
 * search cheap; while the vault is locked they are masked by shape instead
 * (shapes.ts).
 */

export const SCRUB_INDEX_FORMAT = "kos-scrub-index";

export interface IndexEntry {
  /** UTF-16 code units, as JavaScript strings measure them. */
  len: number;
  /** The keyed rolling hash of the window, a prefilter. */
  rk: number;
  /** HMAC-SHA256 of the window under the scrub key, hex. */
  mac: string;
  /** `<handle>.<field>`, for the label it is replaced with. */
  name: string;
}

export interface ScrubIndexFile {
  format: typeof SCRUB_INDEX_FORMAT;
  version: 1;
  entries: IndexEntry[];
}

/** A prime under 2^26, so a hash times the base stays exact in a double. */
const P = 67_108_859;

const baseOf = (key: Buffer): number => (key.readUInt32BE(0) % (P - 2)) + 2;

function rolling(text: string, base: number): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * base + text.charCodeAt(i)) % P;
  return h;
}

const macOf = (key: Buffer, text: string): string => createHmac("sha256", key).update(text, "utf8").digest("hex");

/** The index of every value but card numbers, each in every form the scrubber looks for. */
export function buildIndex(key: Buffer, values: Iterable<Watched>): ScrubIndexFile {
  const base = baseOf(key);
  const seen = new Set<string>();
  const entries: IndexEntry[] = [];
  for (const [name, value, mode = "exact"] of values) {
    if (mode === "digits") continue;
    for (const form of needlesOf(value)) {
      const mac = macOf(key, form);
      if (seen.has(mac)) continue;
      seen.add(mac);
      entries.push({ len: form.length, rk: rolling(form, base), mac, name });
    }
  }
  return { format: SCRUB_INDEX_FORMAT, version: 1, entries };
}

export class ScrubIndex {
  private readonly base: number;
  private readonly byWindow = new Map<string, IndexEntry[]>();
  private readonly lengths: number[];
  /** The longest window, for a stream to hold back. */
  readonly reach: number;

  constructor(
    private readonly key: Buffer,
    file: ScrubIndexFile,
  ) {
    this.base = baseOf(key);
    for (const e of file.entries) {
      const at = `${e.len}:${e.rk}`;
      this.byWindow.set(at, [...(this.byWindow.get(at) ?? []), e]);
    }
    this.lengths = [...new Set(file.entries.map((e) => e.len))].sort((a, b) => b - a);
    this.reach = this.lengths[0] ?? 0;
  }

  /** `text` with every indexed value masked, and which were found how often. */
  found(text: string): { text: string; hits: Map<string, number> } {
    const matches: { start: number; end: number; name: string }[] = [];
    for (const len of this.lengths) {
      if (text.length < len) continue;
      let power = 1;
      for (let i = 1; i < len; i++) power = (power * this.base) % P;
      let h = rolling(text.slice(0, len), this.base);
      for (let start = 0; ; start++) {
        const hit = this.byWindow.get(`${len}:${h}`);
        if (hit) {
          const mac = macOf(this.key, text.slice(start, start + len));
          const entry = hit.find((e) => e.mac === mac);
          if (entry) matches.push({ start, end: start + len, name: entry.name });
        }
        if (start + len >= text.length) break;
        h = ((((h - ((text.charCodeAt(start) * power) % P) + P) % P) * this.base) % P + text.charCodeAt(start + len)) % P;
      }
    }
    const hits = new Map<string, number>();
    if (matches.length === 0) return { text, hits };
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let from = 0;
    for (const m of matches) {
      // Overlapping values are one run: the label already said covers it, and none of the rest shows.
      if (m.start < from) {
        from = Math.max(from, m.end);
        continue;
      }
      out += text.slice(from, m.start) + scrubbedLabel(m.name);
      from = m.end;
      hits.set(m.name, (hits.get(m.name) ?? 0) + 1);
    }
    return { text: out + text.slice(from), hits };
  }
}
