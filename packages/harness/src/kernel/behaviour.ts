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

export interface Behaviour {
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
}

export const BEHAVIOUR_DEFAULTS: Behaviour = {
  autoFix: false,
  maxSteps: 10,
  fixSteps: 24,
  selfPromptsPerHour: 10,
  agentMinutes: 15,
  agentTurns: 60,
  stallMinutes: 3,
};

/** Range for each number, as [min, max]. */
export const BEHAVIOUR_LIMITS: Record<
  Exclude<keyof Behaviour, "autoFix">,
  [number, number]
> = {
  maxSteps: [1, 100],
  fixSteps: [1, 100],
  selfPromptsPerHour: [0, 120],
  agentMinutes: [1, 240],
  agentTurns: [1, 500],
  stallMinutes: [1, 120],
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
    autoFix:
      typeof input["autoFix"] === "boolean" ? input["autoFix"] : legacy,
    maxSteps: clamp(input["maxSteps"], "maxSteps"),
    fixSteps: clamp(input["fixSteps"], "fixSteps"),
    selfPromptsPerHour: clamp(input["selfPromptsPerHour"], "selfPromptsPerHour"),
    agentMinutes: clamp(input["agentMinutes"], "agentMinutes"),
    agentTurns: clamp(input["agentTurns"], "agentTurns"),
    stallMinutes: clamp(input["stallMinutes"], "stallMinutes"),
  };
}
