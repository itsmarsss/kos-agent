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
  /** Why a risky floor asks, in words the owner reads on the card: "deletes the chat for good". */
  why?: string;
  /**
   * Arguments the harness refuses outright, with the reason the model
   * reads, or false. Checked before the tier, so a refused call never
   * reaches the owner as an ask: the fence around KOS's own tables, met
   * on a road around it (the shell opening the database), refuses there
   * as the sql tool does rather than asking the owner to let it through.
   */
  refuse?: (input: Record<string, unknown>) => string | false;
}

export interface RiskAssessment {
  tier: RiskTier;
  /** True when an escalation rule (not the floor) produced a risky tier. */
  escalated: boolean;
  /** Why it asks, when the rule or the floor says so in words. */
  reason?: string;
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
    return { tier: "risky", escalated: false, ...(risk?.why ? { reason: risk.why } : {}) };
  }
  const fired = risk?.escalate?.(input);
  if (fired) {
    return { tier: "risky", escalated: true, ...(typeof fired === "string" ? { reason: fired } : {}) };
  }
  return { tier: "safe", escalated: false };
}
