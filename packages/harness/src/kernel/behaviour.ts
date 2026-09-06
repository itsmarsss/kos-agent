/**
 * How KOS behaves when nobody is telling it what to do.
 *
 * These were constants in the files that used them, which is the right place
 * for a number nobody would ever want to change and the wrong place for one
 * that depends on the owner: how much rope an unattended job gets, how long
 * to let a coding agent run, how hard to try before giving up. Two people
 * running this would reasonably pick different numbers for every one of them.
 *
 * Bounded rather than free: these govern spend and runaway loops, so a typo
 * in a text field should not be able to leave an agent looping for a day.
 */

export const BEHAVIOUR_KEY = "behaviour";

/**
 * Which engine answers a chat turn.
 *
 * "api" calls the model provider directly and bills API credits. "sdk" runs
 * the turn through the Claude Agent SDK, which is what builds already use, so
 * it spends a Claude Code subscription instead. Either way the only tools are
 * KOS's own, behind the same jail and the same approvals.
 */
export type ChatEngine = "api" | "sdk";

export interface Behaviour {
  /** Which engine answers a chat turn. */
  engine: ChatEngine;
  /** Start a fix attempt on the first failure of an unattended job. */
  autoFix: boolean;
  /** Model round-trips a turn may take before it stops and says so. */
  maxSteps: number;
  /** Round-trips a fix attempt gets. Diagnosis is mostly reading. */
  fixSteps: number;
  /** Self-prompting cron fires allowed per rolling hour. */
  selfPromptsPerHour: number;
  /** Minutes a coding agent may run before it is stopped. */
  agentMinutes: number;
  /** Turns a coding agent may take. */
  agentTurns: number;
  /** Minutes of silence after which an agent is reported as stalled. */
  stallMinutes: number;
  /**
   * Minutes a turn will hold, suspended, waiting for the owner to decide
   * about a risky call. After this it treats the silence as a refusal rather
   * than holding that conversation's queue indefinitely.
   */
  approvalMinutes: number;
  /**
   * Minutes between unprompted look-arounds. Zero is off, which is the
   * default: this is the one setting that spends money on a timer rather
   * than because the owner asked for something.
   */
  heartbeatMinutes: number;
}

export const BEHAVIOUR_DEFAULTS: Behaviour = {
  engine: "api",
  autoFix: false,
  maxSteps: 10,
  fixSteps: 24,
  selfPromptsPerHour: 10,
  agentMinutes: 15,
  agentTurns: 60,
  stallMinutes: 3,
  approvalMinutes: 30,
  heartbeatMinutes: 0,
};

/** Range for each number, as [min, max]. */
export const BEHAVIOUR_LIMITS: Record<
  Exclude<keyof Behaviour, "autoFix" | "engine">,
  [number, number]
> = {
  maxSteps: [1, 100],
  fixSteps: [1, 100],
  selfPromptsPerHour: [0, 120],
  agentMinutes: [1, 240],
  agentTurns: [1, 500],
  stallMinutes: [1, 120],
  approvalMinutes: [1, 1440],
  // Zero is off. Below fifteen minutes it is a background process with a
  // model attached, not an assistant checking in.
  heartbeatMinutes: [0, 1440],
};

function clamp(value: unknown, key: keyof typeof BEHAVIOUR_LIMITS): number {
  const [min, max] = BEHAVIOUR_LIMITS[key];
  const fallback = BEHAVIOUR_DEFAULTS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Read a stored or submitted value, filling in anything missing.
 *
 * Also understands the shape the auto-fix switch was stored in before these
 * were collected together, so turning it on does not silently turn itself
 * off again on upgrade.
 */
export function parseBehaviour(raw: unknown, legacyAutoFix?: unknown): Behaviour {
  const input =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const legacy =
    typeof legacyAutoFix === "object" && legacyAutoFix !== null
      ? (legacyAutoFix as { enabled?: unknown }).enabled === true
      : false;

  return {
    engine: input["engine"] === "sdk" ? "sdk" : "api",
    autoFix:
      typeof input["autoFix"] === "boolean" ? input["autoFix"] : legacy,
    maxSteps: clamp(input["maxSteps"], "maxSteps"),
    fixSteps: clamp(input["fixSteps"], "fixSteps"),
    selfPromptsPerHour: clamp(input["selfPromptsPerHour"], "selfPromptsPerHour"),
    agentMinutes: clamp(input["agentMinutes"], "agentMinutes"),
    agentTurns: clamp(input["agentTurns"], "agentTurns"),
    stallMinutes: clamp(input["stallMinutes"], "stallMinutes"),
    approvalMinutes: clamp(input["approvalMinutes"], "approvalMinutes"),
    heartbeatMinutes: clamp(input["heartbeatMinutes"], "heartbeatMinutes"),
  };
}
