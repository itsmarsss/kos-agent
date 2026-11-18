import { createHmac } from "node:crypto";

import { needlesOf, scrubbedLabel, type Watched } from "./scrub.js";

/**
 * A scrub index: what the scrubber needs to find the vault's values while
 * the vault is locked, without holding them.
 *
 * For every value and every encoding the scrubber looks for, it keeps the
 * length and an HMAC-SHA256 under a scrub key of its own (a 0600 file beside
 * the vault, never the vault's key), plus a keyed hash of its first six
 * characters. Text is scanned once: each position's six-character hash is
 * looked up, and only a position whose prefix matches has its windows
 * checked by HMAC.
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
export const SCRUB_INDEX_VERSION = 2;

/** Every value is at least this long (scrub.ts MIN_SCANNED): its first characters say which windows are worth an HMAC. */
export const PREFIX = 6;

/** Past this much text in one call the index does not look; the exact scrubber, when the vault is open, has no such cap. */
export const INDEX_SCAN_MAX = 2 * 1024 * 1024;

export interface IndexEntry {
  /** UTF-16 code units, as JavaScript strings measure them. */
  len: number;
  /** A keyed hash of the first PREFIX characters: one lookup per position finds the candidates. */
  pk: number;
  /** HMAC-SHA256 of the whole window under the scrub key, hex. */
  mac: string;
  /** `<handle>.<field>`, for the label it is replaced with. */
  name: string;
}

export interface ScrubIndexFile {
  format: typeof SCRUB_INDEX_FORMAT;
  version: typeof SCRUB_INDEX_VERSION;
  entries: IndexEntry[];
}

/** A prime under 2^26, so a hash times the base stays exact in a double. */
const P = 67_108_859;

const baseOf = (key: Buffer): number => (key.readUInt32BE(0) % (P - 2)) + 2;

function rolling(text: string, base: number, from = 0, length = text.length): number {
  let h = 0;
  for (let i = from; i < from + length; i++) h = (h * base + text.charCodeAt(i)) % P;
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
      if (form.length < PREFIX) continue;
      const mac = macOf(key, form);
      if (seen.has(mac)) continue;
      seen.add(mac);
      entries.push({ len: form.length, pk: rolling(form, base, 0, PREFIX), mac, name });
    }
  }
  return { format: SCRUB_INDEX_FORMAT, version: SCRUB_INDEX_VERSION, entries };
}

export class ScrubIndex {
  private readonly base: number;
  private readonly byPrefix = new Map<number, IndexEntry[]>();
  /** The longest window, for a stream to hold back. */
  readonly reach: number;
  private readonly power: number;

  constructor(
    private readonly key: Buffer,
    file: ScrubIndexFile,
  ) {
    this.base = baseOf(key);
    for (const e of file.entries) this.byPrefix.set(e.pk, [...(this.byPrefix.get(e.pk) ?? []), e]);
    this.reach = Math.max(0, ...file.entries.map((e) => e.len));
    let power = 1;
    for (let i = 1; i < PREFIX; i++) power = (power * this.base) % P;
    this.power = power;
  }

  /**
   * `text` with every indexed value masked, and which were found how often.
   * One pass: a rolling hash of each PREFIX-character window, looked up;
   * only a window whose prefix matches is checked by its HMAC. Text past
   * INDEX_SCAN_MAX is not looked at.
   */
  found(text: string): { text: string; hits: Map<string, number> } {
    const hits = new Map<string, number>();
    const end = Math.min(text.length, INDEX_SCAN_MAX);
    if (this.byPrefix.size === 0 || end < PREFIX) return { text, hits };
    const matches: { start: number; end: number; name: string }[] = [];
    let h = rolling(text, this.base, 0, PREFIX);
    for (let start = 0; ; start++) {
      const candidates = this.byPrefix.get(h);
      if (candidates) {
        for (const e of candidates) {
          if (start + e.len > end) continue;
          if (macOf(this.key, text.slice(start, start + e.len)) === e.mac) matches.push({ start, end: start + e.len, name: e.name });
        }
      }
      if (start + PREFIX >= end) break;
      h = ((((h - ((text.charCodeAt(start) * this.power) % P) + P) % P) * this.base) % P + text.charCodeAt(start + PREFIX)) % P;
    }
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
