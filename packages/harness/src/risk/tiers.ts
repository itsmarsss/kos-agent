/**
 * Risk tiers. The model never assesses its own risk; the harness computes it in
 * code from a static per-tool floor plus deterministic argument-escalation
 * rules. Safe actions run immediately; risky actions go to the approval queue.
 */

export type RiskTier = "safe" | "risky";

/** Returns true if these arguments should escalate the tool above its floor. */
/** True to escalate, or the reason to, in words the owner reads on the card: "other people can see #leetcode". */
export type Escalation = (input: Record<string, unknown>) => boolean | string;

export interface ToolRisk {
  floor: RiskTier;
  escalate?: Escalation;
  /**
   * Arguments that bring a risky floor down to safe: a shell command that
   * only reads, say. The mirror of escalation, and as deterministic:
   * consulted only on a risky floor, and only ever true for a call the
   * rule can prove harmless.
   */
  relax?: Escalation;
  /**
   * Why a risky floor asks, in words the owner reads on the card: "deletes
   * the chat for good", or read from the call when the reason is in what it
   * acts on (the capabilities a script uses).
   */
  why?: string | ((input: Record<string, unknown>) => string | undefined);
  /**
   * Arguments the harness sets on a call before it is judged, so the owner's
   * yes is to them and the call can check they still hold when it runs: the
   * hash of a script the owner is asked to keep.
   */
  stamp?: (input: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Arguments the harness refuses outright, with the reason the model
   * reads, or false. Checked before the tier, so a refused call never
   * reaches the owner as an ask: the fence around KOS's own tables, met
   * on a road around it (the shell opening the database), refuses there
   * as the sql tool does rather than asking the owner to let it through.
   */
  refuse?: (input: Record<string, unknown>) => string | false;
  /**
   * Arguments a chat's Auto mode never lets through, with the reason in the
   * owner's words, or false: money spent, something deleted outside the
   * workspace. Such a call asks as it would in Ask.
   */
  beyondAuto?: Escalation;
  /**
   * Asks the owner every time: no remembered decision and no Auto covers it
   * (a secret's use). Only the tool's own grants may.
   */
  asksAlways?: boolean;
  /**
   * The call starts a session on one of the owner's devices. Auto covers it
   * only where the owner also let Auto start sessions; a device that asks on
   * itself still asks there.
   */
  startsSession?: boolean;
}

export interface RiskAssessment {
  tier: RiskTier;
  /** True when an escalation rule (not the floor) produced a risky tier. */
  escalated: boolean;
  /** Why it asks, when the rule or the floor says so in words. */
  reason?: string;
  /** Asked about every time: no remembered yes and no Auto covers it (a call that sends a secret, a tool marked so). */
  asksAlways?: true;
  /** Why a risky call is beyond a chat's Auto mode, when it is. */
  beyondAuto?: string;
  /** A risky call that starts a session on the owner's device. */
  startsSession?: true;
}

export const SAFE: ToolRisk = { floor: "safe" };
export const RISKY: ToolRisk = { floor: "risky" };

/**
 * Compute the risk tier for a tool call. A risky floor is risky regardless of
 * arguments, unless a relaxation rule proves the call harmless; a safe floor
 * can be escalated to risky by an argument rule.
 */
export function classifyRisk(
  risk: ToolRisk | undefined,
  input: Record<string, unknown>,
): RiskAssessment {
  const floor = risk?.floor ?? "safe";
  if (floor === "risky") {
    if (risk?.relax?.(input)) return { tier: "safe", escalated: false };
    const why = typeof risk?.why === "function" ? risk.why(input) : risk?.why;
    return { tier: "risky", escalated: false, ...(why ? { reason: why } : {}), ...autoFacts(risk, input) };
  }
  const fired = risk?.escalate?.(input);
  if (fired) {
    return { tier: "risky", escalated: true, ...(typeof fired === "string" ? { reason: fired } : {}), ...autoFacts(risk, input) };
  }
  return { tier: "safe", escalated: false };
}

/** What a risky call's rules say about Auto mode, read only once the call is risky. */
function autoFacts(risk: ToolRisk | undefined, input: Record<string, unknown>): Pick<RiskAssessment, "asksAlways" | "beyondAuto" | "startsSession"> {
  const beyond = risk?.beyondAuto?.(input);
  return {
    ...(risk?.asksAlways ? { asksAlways: true as const } : {}),
    ...(beyond ? { beyondAuto: typeof beyond === "string" ? beyond : "beyond what Auto covers" } : {}),
    ...(risk?.startsSession ? { startsSession: true as const } : {}),
  };
}
