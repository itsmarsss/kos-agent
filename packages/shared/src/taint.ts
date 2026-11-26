import { BIDI, showInvisible } from "./invisible.js";

/**
 * What a turn read that someone other than the owner wrote: a page, an
 * email, a guest's message, rows guests put in a table. Once a turn has
 * read one, no saved yes covers what it does next that reaches outside
 * (the harness's risk/taint.ts), and the ask it raises names what it read,
 * on every surface, from this one line.
 */

/** The kind of outside text a turn read. */
export type TaintKind = "page" | "mail" | "doc" | "file" | "guest" | "rows" | "stored" | "server" | "chat" | "log" | "program";

/** One thing a turn read that the owner did not write: what kind, and where it came from (a host, a sender, a file, a table). */
export interface TaintSource {
  kind: TaintKind;
  /** Host, sender, file name, table or server: short, scrubbed, never a value of the owner's. */
  where?: string;
}

/** The most sources a turn keeps: past this, it is tainted however many more it reads. */
export const TAINT_SOURCES_MAX = 12;
/** The most of them the card's line names; the rest are counted. */
const SHOWN = 3;
/** The longest a source's place reads on the card. */
const WHERE_MAX = 48;

const WORDS: Readonly<Record<TaintKind, (where: string | undefined) => string>> = {
  page: (w) => (w ? `a page on ${w}` : "a web page"),
  mail: (w) => (w ? `an email from ${w}` : "an email"),
  doc: (w) => (w ? `a document, ${w}` : "a document"),
  file: (w) => (w ? `the file ${w}` : "a file someone else wrote"),
  guest: (w) => (w ? `a message from ${w}, a guest` : "a guest's message"),
  rows: (w) => (w ? `rows guests wrote in ${w}` : "rows guests wrote"),
  stored: (w) => (w ? `rows written after outside text, in ${w}` : "rows written after outside text"),
  server: (w) => (w ? `a result from ${w}` : "a connected server's result"),
  chat: (w) => (w ? `what ${w} said` : "another chat's words"),
  log: () => "KOS's log",
  program: (w) => (w ? `the output of ${w}` : "a program's output"),
};

/** A source's place as a card shows it: one line, no fence or quote characters, short. */
export function cleanWhere(where: string | undefined): string | undefined {
  const line = showInvisible((where ?? "").replace(BIDI, "").replace(/[\u0000-\u001f\u007f\u2028\u2029<>`"]+/g, " ").replace(/\s+/g, " ").trim());
  if (!line) return undefined;
  return line.length > WHERE_MAX ? `${line.slice(0, WHERE_MAX - 1).trimEnd()}…` : line;
}

/** Whether two sources are the same one. */
export function sameSource(a: TaintSource, b: TaintSource): boolean {
  return a.kind === b.kind && (a.where ?? "") === (b.where ?? "");
}

/** Sources as kept: each cleaned, the same one once, at most TAINT_SOURCES_MAX. */
export function keptSources(sources: readonly TaintSource[]): TaintSource[] {
  const out: TaintSource[] = [];
  for (const s of sources) {
    const where = cleanWhere(s.where);
    const kept: TaintSource = where ? { kind: s.kind, where } : { kind: s.kind };
    if (!WORDS[kept.kind] || out.some((o) => sameSource(o, kept))) continue;
    out.push(kept);
    if (out.length === TAINT_SOURCES_MAX) break;
  }
  return out;
}

/**
 * The card's line: "After reading: an email from x@y, a page on
 * example.com". Undefined for an untainted ask.
 */
export function taintLine(sources: readonly TaintSource[] | null | undefined): string | undefined {
  const kept = keptSources(sources ?? []);
  if (!kept.length) return undefined;
  const named = kept.slice(0, SHOWN).map((s) => WORDS[s.kind](s.where));
  const more = kept.length - SHOWN;
  return `After reading: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

/** Sources read back from storage or the wire: anything not of their shape is dropped. */
export function readSources(v: unknown): TaintSource[] {
  if (!Array.isArray(v)) return [];
  const shaped = v.filter((s): s is TaintSource => typeof s === "object" && s !== null && typeof (s as TaintSource).kind === "string" && ((s as TaintSource).where === undefined || typeof (s as TaintSource).where === "string"));
  return keptSources(shaped);
}
