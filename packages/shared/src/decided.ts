import { momentWords } from "./chattime.js";

/**
 * Where a decision on an ask came from, kept with the ask and with the
 * audit of the call it let run.
 *
 * An approval that ran a delete two hours after its chat had gone said only
 * decided_by 'owner': nobody could tell which surface had pressed it. Every
 * path that settles an ask now names itself.
 *
 * - a surface the owner pressed on: "dashboard", "discord", "sms",
 *   "imessage", "mac", "phone", "chrome", "cli"
 * - a typed /approve or /deny on one: "typed:discord"
 * - nobody asked: "auto" (the chat's Auto mode), "rule" (a remembered yes),
 *   "grant" (a yes its own tool kept)
 * - nobody decided: "timeout", "stopped", "kill-switch", "chat-deleted",
 *   "restart" and "shutdown" (KOS stopped under the turn that waited),
 *   "turn-gone" (approved once the turn that waited had gone)
 */
export type DecidedVia = LapseVia | "auto" | "rule" | "grant" | `typed:${string}` | (string & Record<never, never>);

/** How an ask settles with nobody deciding. */
export type LapseVia = "timeout" | "stopped" | "kill-switch" | "chat-deleted" | "restart" | "shutdown" | "turn-gone";

/** The surfaces by the names the owner knows them by; any other is said as it is stored. */
const SURFACE_NAMES: Readonly<Record<string, string>> = {
  dashboard: "the dashboard",
  discord: "Discord",
  sms: "SMS",
  imessage: "iMessage",
  mac: "KOS for Mac",
  phone: "KOS for iPhone",
  chrome: "Chrome",
  cli: "the command line",
};

/** Why an ask lapsed, as the Inbox says it after "Lapsed: ". */
const LAPSE_WORDS: Readonly<Record<Exclude<LapseVia, "timeout">, string>> = {
  stopped: "its chat was stopped before you decided",
  "kill-switch": "the kill switch was thrown",
  "chat-deleted": "its chat was deleted",
  restart: "its chat stopped before you decided, when KOS restarted",
  shutdown: "its chat stopped before you decided, when KOS shut down",
  "turn-gone": "its chat stopped before you decided",
};

/** The typed form of a decision taken on a surface. */
export function typedVia(surface: string): DecidedVia {
  return `typed:${surface}`;
}

/** A span the owner reads: "30 minutes", "2 hours", "1 day". */
function spanWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [n, unit] = minutes < 90 ? [minutes, "minute"] : minutes < 36 * 60 ? [Math.round(minutes / 60), "hour"] : [Math.round(minutes / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Where a press came from, after "Approved " or "Denied ". */
function placeWords(via: string): string {
  if (via === "auto") return "by Auto mode";
  if (via === "rule") return "by a remembered rule";
  if (via === "grant") return "by a yes its tool kept";
  const typed = via.startsWith("typed:") ? via.slice("typed:".length) : undefined;
  if (typed !== undefined) return `by a typed command on ${SURFACE_NAMES[typed] ?? typed}`;
  return `on ${SURFACE_NAMES[via] ?? via}`;
}

export interface DecidedFacts {
  status: "approved" | "denied" | "expired";
  decidedVia: string | null;
  decidedAt: number | null;
  requestedAt: number;
}

/**
 * How an ask was settled, in one line: "Approved on Discord, 2:11 PM",
 * "Lapsed: nobody decided in 30 minutes". A row from before this was kept
 * says where is unknown.
 */
export function decidedWords(a: DecidedFacts, now = Date.now()): string {
  const word = a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : "Lapsed";
  const when = a.decidedAt !== null ? momentWords(a.decidedAt, now) : undefined;
  const at = when ? `, ${when}` : "";
  if (a.status === "expired") {
    const via = a.decidedVia;
    if (via === "timeout") return a.decidedAt !== null ? `Lapsed: nobody decided in ${spanWords(a.decidedAt - a.requestedAt)}` : "Lapsed: nobody decided in time";
    if (via && via in LAPSE_WORDS) return `Lapsed: ${LAPSE_WORDS[via as keyof typeof LAPSE_WORDS]}`;
    return `Lapsed${at}; why is unknown`;
  }
  if (!a.decidedVia) return `${word}${at}; where is unknown`;
  return `${word} ${placeWords(a.decidedVia)}${at}`;
}
