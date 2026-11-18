import { createHmac } from "node:crypto";

import { needlesOf, scrubbedLabel, type Watched } from "./scrub.js";

/**
 * A scrub index: what the scrubber needs to find the vault's values while
 * the vault is locked, without holding them.
 *
 * For every value and every encoding the scrubber looks for, it keeps the
 * length and an HMAC-SHA256 under a scrub key of its own (a 0600 file beside
 * the vault, never the vault's key), plus a keyed 61-bit hash of its first
 * six characters. Text is scanned once: each position's six-character hash is
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
export const SCRUB_INDEX_VERSION = 3;

/** Every value is at least this long (scrub.ts MIN_SCANNED): its first characters say which windows are worth an HMAC. */
export const PREFIX = 6;


export interface IndexEntry {
  /** UTF-16 code units, as JavaScript strings measure them. */
  len: number;
  /** A keyed hash of the first PREFIX characters, as a decimal string: one lookup per position finds the candidates. */
  pk: string;
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

/**
 * The prefix hash: a polynomial over the prefix's UTF-16 code units modulo
 * the Mersenne prime 2^61 - 1, its base taken from 8 bytes of the scrub key.
 * A 61-bit field keeps an attacker who can plant text from finding prefix
 * collisions by chance (a 26-bit one had them every few million windows),
 * and keyed, the hash says nothing about a prefix without the key; it costs
 * a few BigInt steps a character, where an HMAC at every position would cost
 * a hash each. It only picks the windows an HMAC then confirms.
 */
const M = (1n << 61n) - 1n;

const baseOf = (key: Buffer): bigint => (key.readBigUInt64BE(0) % (M - 2n)) + 2n;

function prefixHash(text: string, base: bigint, from = 0): bigint {
  let h = 0n;
  for (let i = from; i < from + PREFIX; i++) h = (h * base + BigInt(text.charCodeAt(i))) % M;
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
      entries.push({ len: form.length, pk: prefixHash(form, base).toString(), mac, name });
    }
  }
  return { format: SCRUB_INDEX_FORMAT, version: SCRUB_INDEX_VERSION, entries };
}

export class ScrubIndex {
  private readonly base: bigint;
  private readonly byPrefix = new Map<bigint, IndexEntry[]>();
  /** The longest window, for a stream to hold back. */
  readonly reach: number;
  private readonly power: bigint;

  constructor(
    private readonly key: Buffer,
    file: ScrubIndexFile,
  ) {
    this.base = baseOf(key);
    for (const e of file.entries) {
      const pk = BigInt(e.pk);
      this.byPrefix.set(pk, [...(this.byPrefix.get(pk) ?? []), e]);
    }
    this.reach = Math.max(0, ...file.entries.map((e) => e.len));
    let power = 1n;
    for (let i = 1; i < PREFIX; i++) power = (power * this.base) % M;
    this.power = power;
  }

  /**
   * `text` with every indexed value masked, and which were found how often.
   * One pass over the whole text, however long, the prefix hash rolled from
   * each position to the next: only a window whose prefix matches is
   * checked by its HMAC, so no value is missed at any offset.
   */
  found(text: string): { text: string; hits: Map<string, number> } {
    const hits = new Map<string, number>();
    const end = text.length;
    if (this.byPrefix.size === 0 || end < PREFIX) return { text, hits };
    const matches: { start: number; end: number; name: string }[] = [];
    let h = prefixHash(text, this.base);
    for (let start = 0; ; start++) {
      const candidates = this.byPrefix.get(h);
      if (candidates) {
        for (const e of candidates) {
          if (start + e.len > end) continue;
          if (macOf(this.key, text.slice(start, start + e.len)) === e.mac) matches.push({ start, end: start + e.len, name: e.name });
        }
      }
      if (start + PREFIX >= end) break;
      h = ((((h - BigInt(text.charCodeAt(start)) * this.power) % M) + M) % M * this.base + BigInt(text.charCodeAt(start + PREFIX))) % M;
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
