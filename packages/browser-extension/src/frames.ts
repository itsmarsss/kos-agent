import { isHidden } from "./settings.js";

/**
 * The pictures of a chat's steps, as the side panel keeps them: what KOS
 * sent with each step as it ran, and the newest ones it sends with the chat
 * as it stands. Kept by frame id, the newest few, so a step drawn again
 * still has its picture; a picture of a site the owner hid in this Chrome
 * is never drawn, whatever sent it.
 */

export interface Pictured {
  image: string;
  /** The host of the page it shows; none for a screen. */
  site?: string;
}

/** How many pictures the panel keeps. */
export const PICTURES_KEPT = 40;

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** The picture a running turn's status carries, by its frame id. */
export function frameOf(message: Record<string, unknown>): [number, Pictured] | undefined {
  const frame = record(message["frame"]);
  const id = frame?.["id"];
  const image = frame?.["image"];
  if (typeof id !== "number" || typeof image !== "string" || !image) return undefined;
  return [id, { image, ...(typeof frame?.["site"] === "string" ? { site: frame["site"] } : {}) }];
}

/** The pictures the chat came with, each with the site it shows. */
export function picturesOf(message: Record<string, unknown>): [number, Pictured][] {
  const pictures = record(message["pictures"]) ?? {};
  const sites = record(message["sites"]) ?? {};
  return Object.entries(pictures).flatMap(([id, image]) => {
    const n = Number(id);
    const site = sites[id];
    return Number.isInteger(n) && typeof image === "string" && image ? [[n, { image, ...(typeof site === "string" ? { site } : {}) }] as [number, Pictured]] : [];
  });
}

/** The cache with these added, the newest kept and the oldest let go past the cap. */
export function keep(cache: ReadonlyMap<number, Pictured>, added: [number, Pictured][], max = PICTURES_KEPT): Map<number, Pictured> {
  if (!added.length) return cache as Map<number, Pictured>;
  const next = new Map(cache);
  for (const [id, p] of added) {
    next.delete(id);
    next.set(id, p);
  }
  while (next.size > max) next.delete(next.keys().next().value!);
  return next;
}

/** Whether a picture may be drawn here: not one of a site the owner hid in this Chrome. */
export function showable(p: Pictured | undefined, hidden: readonly string[]): p is Pictured {
  return p !== undefined && !(p.site && isHidden(`https://${p.site}/`, hidden));
}

/** A picture as an image source. */
export const pictureSrc = (p: Pictured): string => `data:image/jpeg;base64,${p.image}`;
