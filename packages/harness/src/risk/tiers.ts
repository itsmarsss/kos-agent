import type { AskSecret, TaintSource } from "@kos/shared";

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
  stamp?: (input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Arguments the harness refuses outright, with the reason the model
   * reads, or false. Checked before the tier, so a refused call never
   * reaches the owner as an ask: the fence around KOS's own tables, met
   * on a road around it (the shell opening the database), refuses there
   * as the sql tool does rather than asking the owner to let it through.
   */
  refuse?: (input: Record<string, unknown>) => string | false | Promise<string | false>;
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
   * Arguments no learned yes may cover (a burst, a job's consent), though a
   * remembered rule or Auto may: a write to KOS's own tables, which the
   * owner decides each time unless they pressed Always for it.
   */
  neverLearned?: Escalation;
  /**
   * For a tool that asks every time: whether this call runs without asking
   * on a yes the tool keeps itself (a secret's grant on a site, or for the
   * rest of a turn), never a permission rule or Auto. Still audited.
   * Judged inside the turn's stores.
   */
  granted?: (input: Record<string, unknown>) => boolean;
  /** The secret an ask about this call places, for its card: never a value. */
  secret?: (input: Record<string, unknown>) => AskSecret | undefined;
  /** A yes-and-remember the tool keeps itself, in place of a permission rule: true when it kept one. */
  keep?: (input: Record<string, unknown>) => boolean;
  /**
   * What the audit, and the approval once it is decided, keep of a call
   * when not all of it: a read of the owner's clipboard keeps that it
   * happened and how much, never what it held. The arguments are as
   * stamped; the result is the call's own words, or its error.
   */
  audited?: (input: Record<string, unknown>, result: { content: string; isError: boolean }) => { args: Record<string, unknown>; result: string };
  /**
   * What outside text this call's result carries, when only the tool can
   * tell (a kept result brought back is whatever it was read from): the
   * turn is tainted with it (risk/taint.ts). Most tools are read from their
   * name (risk/untrusted.ts); this is for the rest.
   */
  untrusted?: (input: Record<string, unknown>, result: { content: string; isError: boolean }) => TaintSource | undefined;
  /**
   * What an ask becomes once no turn waits on its answer (decisions.ts,
   * orphanFate). By default an ask a turn held for lapses when that turn
   * goes (a restart, a shutdown, a Stop), and one nothing ever waited on (a
   * schedule's) runs when approved, its card warning so.
   *
   * "runs": its effect is the point on its own (a message sent, a schedule
   * made), so an ask whose turn has gone stays, its card warning that a yes
   * runs it with the result going to its chat. Never for a call that
   * deletes or runs code.
   * "never": it runs only for the turn waiting on it, even a schedule's
   * ask lapsing rather than running for nobody, as a secret's does.
   */
  detached?: "runs" | "never";
  /**
   * The call starts a session on one of the owner's devices. Auto covers it
   * only where the owner also let Auto start sessions; a device that asks on
   * itself still asks there.
   */
  startsSession?: boolean;
  /**
   * Raises the call one notch for where it reaches rather than what it
   * does: a write outside the calling turn's own folder. A safe call then
   * asks, with these words on the card; a call already asking says them
   * beside its own reason. Judged inside the turn's stores, since where a
   * turn's own folder is depends on who is calling.
   */
  reach?: (input: Record<string, unknown>) => Reach | false;
}

/** Where a call reaches beyond the calling turn's own folder: the card's words, and why Auto never covers it, when it does not. */
export interface Reach {
  why: string;
  /** Set for a write into another project's or a blob's folder: Auto mode asks for it as Ask does. */
  beyondAuto?: string;
}

export interface RiskAssessment {
  tier: RiskTier;
  /** True when an escalation rule (not the floor) produced a risky tier. */
  escalated: boolean;
  /** Why it asks, when the rule or the floor says so in words. */
  reason?: string;
  /** The reach rule fired: a decision remembered inside the turn's own folder never covers it. */
  reached?: true;
  /** Asked about every time: no remembered yes and no Auto covers it (a call that sends a secret, a tool marked so). */
  asksAlways?: true;
  /** Why a risky call is beyond a chat's Auto mode, when it is. */
  beyondAuto?: string;
  /** No learned yes (a burst, a job's consent) covers this call. */
  neverLearned?: true;
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
  const reach = risk?.reach?.(input) || undefined;
  // The call's own reason first, where it reaches beside it.
  const told = (own: string | undefined): Pick<RiskAssessment, "reason" | "reached"> => {
    const reason = [own, reach?.why].filter(Boolean).join(", ");
    return { ...(reason ? { reason } : {}), ...(reach ? { reached: true as const } : {}) };
  };
  if (floor === "risky") {
    if (risk?.relax?.(input)) return { tier: "safe", escalated: false };
    const why = typeof risk?.why === "function" ? risk.why(input) : risk?.why;
    return { tier: "risky", escalated: false, ...told(why), ...autoFacts(risk, input, reach) };
  }
  const fired = risk?.escalate?.(input);
  if (fired) {
    return { tier: "risky", escalated: true, ...told(typeof fired === "string" ? fired : undefined), ...autoFacts(risk, input, reach) };
  }
  if (reach) return { tier: "risky", escalated: true, ...told(undefined), ...autoFacts(risk, input, reach) };
  return { tier: "safe", escalated: false };
}

/** What a risky call's rules say about Auto mode, read only once the call is risky: the tool's own word first, then where it reaches. */
function autoFacts(risk: ToolRisk | undefined, input: Record<string, unknown>, reach: Reach | undefined): Pick<RiskAssessment, "asksAlways" | "beyondAuto" | "startsSession" | "neverLearned"> {
  const beyond = risk?.beyondAuto?.(input) || reach?.beyondAuto;
  return {
    ...(risk?.neverLearned?.(input) ? { neverLearned: true as const } : {}),
    ...(risk?.asksAlways ? { asksAlways: true as const } : {}),
    ...(beyond ? { beyondAuto: typeof beyond === "string" ? beyond : "beyond what Auto covers" } : {}),
    ...(risk?.startsSession ? { startsSession: true as const } : {}),
  };
}
