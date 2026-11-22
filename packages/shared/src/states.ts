/**
 * A state as the owner reads it, in one word and one tone on every surface:
 * a run, a step, a schedule, a blob, a project, an ask. A pill draws these
 * and nothing else, so "off" is never "Off" on one page and "paused" on
 * another, and an idle blob is never drawn in the colour of success.
 */

/** How a state is coloured: by what it means, never by what to press. */
export type StateTone = "ok" | "warn" | "danger" | "accent" | "muted";

export const STATE_WORDS = {
  ok: { word: "Done", tone: "ok" },
  failed: { word: "Failed", tone: "danger" },
  running: { word: "Running", tone: "accent" },
  waiting: { word: "Needs you", tone: "warn" },
  skipped: { word: "Not run", tone: "muted" },
  on: { word: "On", tone: "ok" },
  off: { word: "Off", tone: "muted" },
  idle: { word: "Quiet", tone: "muted" },
  active: { word: "Active", tone: "ok" },
  born: { word: "New", tone: "accent" },
  dormant: { word: "Dormant", tone: "muted" },
  done: { word: "Finished", tone: "muted" },
  archived: { word: "Archived", tone: "muted" },
  held: { word: "Held", tone: "warn" },
  approved: { word: "Approved", tone: "ok" },
  denied: { word: "Denied", tone: "danger" },
  expired: { word: "Lapsed", tone: "muted" },
} as const satisfies Record<string, { word: string; tone: StateTone }>;

export type State = keyof typeof STATE_WORDS;

export function isState(v: unknown): v is State {
  return typeof v === "string" && Object.hasOwn(STATE_WORDS, v);
}

/** A run's or a step's status as stored, as the state it is drawn as: "error" and "failed" alike are Failed. */
export function stateOfRun(status: string): State {
  if (status === "ok" || status === "success" || status === "done") return "ok";
  if (status === "error" || status === "failed" || status === "timeout") return "failed";
  if (status === "running" || status === "started") return "running";
  if (status === "waiting" || status === "pending") return "waiting";
  return "skipped";
}
