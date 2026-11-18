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
   * Raises the call one notch for where it reaches rather than what it
   * does: a write outside the calling turn's own folder. A safe call then
   * asks, with these words on the card; a call already asking says them
   * beside its own reason. Judged inside the turn's stores, since where a
   * turn's own folder is depends on who is calling.
   */
  reach?: Escalation;
}

export interface RiskAssessment {
  tier: RiskTier;
  /** True when an escalation rule (not the floor) produced a risky tier. */
  escalated: boolean;
  /** Why it asks, when the rule or the floor says so in words. */
  reason?: string;
  /**
   * True when only the reach rule made the call ask: it would run at once
   * inside the turn's own folder. The hook for a chat the owner set to Auto,
   * which may let such a call run where it would still ask for one risky in
   * itself.
   */
  raised?: boolean;
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
  const reach = risk?.reach?.(input);
  const reachWords = typeof reach === "string" ? reach : undefined;
  const joined = (own: string | undefined): { reason?: string } => {
    const reason = [own, reachWords].filter(Boolean).join(", ");
    return reason ? { reason } : {};
  };
  if (floor === "risky") {
    if (risk?.relax?.(input)) return { tier: "safe", escalated: false };
    const why = typeof risk?.why === "function" ? risk.why(input) : risk?.why;
    return { tier: "risky", escalated: false, ...joined(why) };
  }
  const fired = risk?.escalate?.(input);
  if (fired) {
    return { tier: "risky", escalated: true, ...joined(typeof fired === "string" ? fired : undefined) };
  }
  if (reach) return { tier: "risky", escalated: true, raised: true, ...joined(undefined) };
  return { tier: "safe", escalated: false };
}
