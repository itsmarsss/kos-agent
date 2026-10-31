/**
 * The KOS this Chrome is paired with, in the order they were paired.
 *
 * Several, as KOS Device pairs a Mac with several: one KOS at home and one
 * at work, each its own line, its own trust and its own consent. Pairing
 * again with a KOS already here replaces that pairing rather than adding a
 * second line to the same KOS.
 */

export interface Paired {
  url: string;
  /** This Chrome's device id in that KOS. */
  device: string;
  hostKey: string;
  /** What this Chrome is called there. */
  name: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isPaired(v: unknown): v is Paired {
  return isRecord(v) && typeof v["url"] === "string" && typeof v["device"] === "string" && typeof v["hostKey"] === "string" && typeof v["name"] === "string";
}

/** The KOS a pairing is with, one address however it was typed. */
export function kosOf(p: Pick<Paired, "url">): string {
  try {
    return new URL(p.url).origin;
  } catch {
    return p.url;
  }
}

/** The pairings stored: the list, or the one pairing an older version kept. */
export function readPairings(list: unknown, one: unknown): Paired[] {
  if (Array.isArray(list)) return list.filter(isPaired);
  return isPaired(one) ? [one] : [];
}

/** The pairings `next` takes the place of: the same KOS, or the same device id. */
export function replacedBy(next: Paired, list: readonly Paired[]): Paired[] {
  return list.filter((p) => kosOf(p) === kosOf(next) || p.device === next.device);
}

/** `list` with `next` in it: in place of the pairing it replaces, else after the rest. */
export function adding(next: Paired, list: readonly Paired[]): Paired[] {
  const old = new Set(replacedBy(next, list).map((p) => p.device));
  const at = list.findIndex((p) => old.has(p.device));
  if (at < 0) return [...list, next];
  return list.flatMap((p, i) => (i === at ? [next] : old.has(p.device) ? [] : [p]));
}

export function removing(device: string, list: readonly Paired[]): Paired[] {
  return list.filter((p) => p.device !== device);
}
