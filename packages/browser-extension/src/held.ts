import type { EndReason } from "./session.js";

/**
 * The session this Chrome holds, or held and has not yet told its KOS the
 * end of, kept in session storage beside the worker's memory.
 *
 * Chrome stops an extension's worker when it likes, and a worker started
 * again remembers nothing: a session it held would end with no word to KOS,
 * which would keep it as live. So the session's id, its KOS and its tabs are
 * kept as it begins. A worker that finds one at its start lost that session
 * (its debugger and pages with it), lets its tabs go, and says so in its
 * next hello to that KOS. A session that ended while its KOS's line was
 * down is said the same way. Its hello to that KOS says the session it
 * still holds after a short drop, so KOS keeps it.
 */
export interface HeldSession {
  id: string;
  /** The KOS whose session it is. */
  kos: string;
  /** The tabs it had under the debugger, to let go of when the worker that had them is gone. */
  tabs: number[];
  /** The chat it was for, whose side panel is told why it ended. */
  conversation?: string;
  /** Why it ended, while its KOS has not heard. */
  ended?: EndReason;
}

const REASONS: readonly EndReason[] = ["owner", "expired", "idle", "detached", "host", "restarted"];

export const HELD_KEY = "session";

/** What session storage kept, or none for anything else. */
export function readHeld(v: unknown): HeldSession | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r["id"] !== "string" || !r["id"] || typeof r["kos"] !== "string") return undefined;
  const tabs = Array.isArray(r["tabs"]) ? r["tabs"].filter((t): t is number => Number.isInteger(t)) : [];
  const ended = REASONS.find((reason) => reason === r["ended"]);
  const conversation = typeof r["conversation"] === "string" && r["conversation"] ? r["conversation"] : undefined;
  return { id: r["id"], kos: r["kos"], tabs, ...(conversation ? { conversation } : {}), ...(ended ? { ended } : {}) };
}

/** Why a chat's last session here ended, and when: told to a side panel on that chat, opened or found again soon after. */
export interface Ended {
  conversation: string;
  reason: EndReason;
  at: number;
}

export const ENDED_KEY = "ended";
/** How long after a session ended a panel found again is still told why. */
export const ENDED_TOLD_MS = 10 * 60_000;

export function readEnded(v: unknown): Ended | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const reason = REASONS.find((x) => x === r["reason"]);
  return typeof r["conversation"] === "string" && reason && typeof r["at"] === "number" ? { conversation: r["conversation"], reason, at: r["at"] } : undefined;
}

/** What a panel on `conversation` is told of its last session here at `now`: why it ended, while that is recent. */
export function endedFor(ended: Ended | undefined, conversation: string | undefined, now: number): Ended | undefined {
  return ended && conversation === ended.conversation && now - ended.at < ENDED_TOLD_MS ? ended : undefined;
}

/** Found by a worker as it starts: one still live was the last worker's, and ended with it. */
export function afterRestart(held: HeldSession | undefined): HeldSession | undefined {
  return held && !held.ended ? { ...held, ended: "restarted" } : held;
}

/** What a hello to a KOS says of the session: the one it still holds, or the one that ended while it was away and why. Nothing to any other KOS. */
export function helloSession(held: HeldSession | undefined, kos: string): { id: string; ended?: EndReason } | undefined {
  if (held?.kos !== kos) return undefined;
  return { id: held.id, ...(held.ended ? { ended: held.ended } : {}) };
}

/** Why a session ended, as the side panel tells the owner. */
export function endedWords(reason: EndReason): string {
  switch (reason) {
    case "owner":
      return "You stopped it.";
    case "expired":
      return "Its time ran out.";
    case "idle":
      return "It sat idle too long.";
    case "detached":
      return "Chrome's debugging bar was closed.";
    case "restarted":
      return "KOS for Chrome restarted, which ends a session.";
    case "host":
      return "KOS ended it, or the line to KOS dropped.";
  }
}
