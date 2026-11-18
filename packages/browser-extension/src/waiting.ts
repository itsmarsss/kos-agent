/**
 * What the owner pressed while it could not go on at once: the worker was
 * away from the side panel, or the line to KOS was down. Each is kept with
 * when it was pressed. A Stop is about the turn running when it was
 * pressed, so it lapses after a minute, and tells KOS how long it waited:
 * KOS lets it go when the turn running by then began after the press. A
 * Stop that names no chat is not kept at all: nobody could say which chat
 * it was for by the time it went.
 */

/** How long a Stop still counts once pressed. */
export const STOP_LAPSES_MS = 60_000;

/** An event for a KOS that waits for its line, kept in session storage across the worker's restarts. */
export interface WaitingEvent {
  kos: string;
  name: "chat.stop" | "chat.decide";
  data: Record<string, unknown>;
  /** When the owner pressed it, epoch ms. */
  at: number;
}

export const WAITING_KEY = "waiting";
const WAITING_MAX = 20;

/** Whether something pressed at `at` is too old to go at `now`: a Stop after a minute; a decision never (KOS knows whether it still waits). */
export function lapsed(stop: boolean, at: number, now: number): boolean {
  return stop && now - at >= STOP_LAPSES_MS;
}

/** A Stop's words to KOS, with how long ago it was pressed (in ms, so neither clock need agree with the other). */
export function stopWith(data: Record<string, unknown>, at: number, now: number): Record<string, unknown> {
  return { ...data, waited: Math.max(0, now - at) };
}

/** Kept to wait for a line, or refused: a Stop naming no chat. The newest few are kept. */
export function queued(all: WaitingEvent[], next: WaitingEvent): WaitingEvent[] {
  if (next.name === "chat.stop" && typeof next.data["chat"] !== "string") return all;
  return [...all, next].slice(-WAITING_MAX);
}

/** What is due to a KOS back on its line, in order, and what still waits for the others. */
export function due(all: WaitingEvent[], kos: string, now: number): { send: { name: WaitingEvent["name"]; data: Record<string, unknown> }[]; rest: WaitingEvent[] } {
  const mine = all.filter((e) => e.kos === kos);
  return {
    send: mine.filter((e) => !lapsed(e.name === "chat.stop", e.at, now)).map((e) => ({ name: e.name, data: e.name === "chat.stop" ? stopWith(e.data, e.at, now) : e.data })),
    rest: all.filter((e) => e.kos !== kos),
  };
}

export function readWaiting(v: unknown): WaitingEvent[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e: unknown) => {
    const r = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
    const name = r["name"] === "chat.stop" || r["name"] === "chat.decide" ? r["name"] : undefined;
    const data = typeof r["data"] === "object" && r["data"] !== null ? (r["data"] as Record<string, unknown>) : undefined;
    return name && data && typeof r["kos"] === "string" && typeof r["at"] === "number" ? [{ kos: r["kos"], name, data, at: r["at"] }] : [];
  });
}
