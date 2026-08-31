import type { ToolBox } from "../agent/loop.js";
import type { ToolExecution, ToolRegistry } from "../agent/registry.js";
import type { AuditLog } from "../ops/audit.js";
import type { ApprovalQueue, PendingAction } from "../ops/approvals.js";
import { injectSecrets } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";

export interface GuardedToolsDeps {
  registry: ToolRegistry;
  secrets: SecretsRegistry;
  audit: AuditLog;
  approvals: ApprovalQueue;
  userId?: string;
  /**
   * Active scope tags. When set (non-empty), tagged tools are filtered to the
   * intersection plus all untagged (global) tools. When omitted/empty, every
   * registered tool is offered (scoping is advisory, never a hard lock-out).
   */
  scopeTags?: string[];
  /** Cap tools offered to the model (default unlimited). */
  toolLimit?: number;
  /**
   * Hard allow-list of tool name prefixes for this conversation. Omitted means
   * unrestricted; an empty array means no tools at all. Unlike scope tags this
   * withholds rather than merely hides, which is what makes a scoped agent
   * meaningfully scoped.
   */
  allow?: string[];
  /**
   * Restricted tools granted to this turn by name. Nothing else can reach
   * them, so a tool that operates on other conversations stays out of an
   * ordinary conversation entirely.
   */
  grant?: string[];
  /** Notified when a risky call is queued, so a channel can prompt for approval. */
  onQueued?: (action: PendingAction) => void;
  /** The conversation making the call, so approving resumes the right agent. */
  conversationId?: string;
  /**
   * Called after a tool actually ran. Some tools change state the kernel holds
   * outside the database, and it has to hear about it.
   */
  onExecuted?: (tool: string, result: ToolExecution) => void;
  /** Called as a call begins, so a reader can see the step it is on. */
  onStarted?: (tool: string, input: Record<string, unknown>) => void;
}

/**
 * A queued risky call reports success, because nothing went wrong: it simply
 * has not happened yet. Readers need to tell those apart from a call that ran,
 * so the message carries a stable prefix both the model and the transcript
 * parse, rather than each guessing from prose.
 */
export const QUEUED_PREFIX = "queued for approval (pending #";

/** Identical calls allowed in one turn before the harness calls it a loop. */
const REPEAT_LIMIT = 2;

/** The pending-action id in a queued tool result, if that is what this is. */
export function parseQueuedApproval(result: string): string | null {
  const match = /^queued for approval \(pending #([^)]+)\)/.exec(result);
  return match?.[1] ?? null;
}

/**
 * The guarded tool path the kernel hands to the agent loop. For every call it:
 *  1. classifies risk in the harness (never the model),
 *  2. queues risky calls for approval and returns without executing,
 *  3. injects `{{secret:name}}` references at call time (model never sees keys),
 *  4. executes safe calls and records a redacted audit entry.
 * The model is offered scoped tools when tags are active.
 */
export class GuardedTools implements ToolBox {
  /** Identical calls made this turn, keyed by tool name and arguments. */
  private readonly repeats = new Map<string, number>();

  constructor(private readonly deps: GuardedToolsDeps) {}

  /** Does this tool survive the conversation's allow-list? */
  private permitted(name: string): boolean {
    const { allow, grant, registry } = this.deps;
    if (registry.isRestricted(name)) return (grant ?? []).includes(name);
    // Undefined is unrestricted. An allow-list that happens to be empty is a
    // real answer -- no tools -- not an absent one.
    if (allow === undefined) return true;
    return allow.some((prefix) => name === prefix || name.startsWith(`${prefix}.`));
  }

  /**
   * What to tell a scoped conversation about its own reach, or null when it is
   * unrestricted. Absent tools are invisible: without this the agent cannot
   * tell "there is no such capability" from "not in this conversation", so it
   * improvises with whatever it does have rather than saying it cannot.
   */
  scopeNote(): string | null {
    const { allow } = this.deps;
    if (allow === undefined) return null;
    if (allow.length === 0) {
      return "This conversation has no tools. Answer from what you know, and say plainly when something would need one.";
    }
    return [
      `This conversation is limited to these tools: ${allow.join(", ")}. There are no others here.`,
      "If the owner asks for something they do not cover, say that plainly in one sentence and stop. Do not reach for a tool you do have as a substitute for one you do not: writing a memory entry saying a change was made is not making the change, and leaves a false record behind.",
    ].join(" ");
  }

  defs(): ReturnType<ToolRegistry["defs"]> {
    const { registry, scopeTags, toolLimit, grant } = this.deps;
    const granted = grant?.length ? registry.restrictedDefs(grant) : [];
    const all = [...registry.defs(), ...granted].filter((d) =>
      this.permitted(d.name),
    );

    // Scoping exists for the many-modules case. While every tool still fits
    // under the cap, narrowing only makes the offered set change shape from
    // turn to turn as the scope inference reads a different message, which
    // reads to the model as capabilities appearing and vanishing mid-task.
    const fitsWithoutScoping =
      toolLimit === undefined || registry.size <= toolLimit;
    if (fitsWithoutScoping || !scopeTags || scopeTags.length === 0) {
      return toolLimit !== undefined ? all.slice(0, toolLimit) : all;
    }

    const scoped = registry
      .scopedDefs({ tags: scopeTags })
      .filter((d) => this.permitted(d.name));
    const withGrants = [...scoped, ...granted];
    return toolLimit !== undefined ? withGrants.slice(0, toolLimit) : withGrants;
  }

  /**
   * Break a repeated call.
   *
   * The same tool with the same arguments returns the same thing, so a third
   * attempt is a loop, not progress. Left alone the agent spends its whole
   * step budget on it and the turn ends with no answer at all. Counted per
   * instance, and an instance is one turn.
   */
  private repeatGuard(name: string, input: Record<string, unknown>): string | null {
    const key = `${name}:${JSON.stringify(input)}`;
    const seen = (this.repeats.get(key) ?? 0) + 1;
    this.repeats.set(key, seen);
    if (seen <= REPEAT_LIMIT) return null;
    return [
      `You have already called ${name} with these exact arguments ${seen - 1} times in this turn.`,
      "It returns the same thing every time, so calling it again cannot make progress.",
      "Do something different, or tell the owner what is blocking you.",
    ].join(" ");
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecution> {
    const { registry, secrets, audit, approvals, userId, conversationId } =
      this.deps;

    const repeated = this.repeatGuard(name, input);
    if (repeated) return { content: repeated, isError: true };

    this.deps.onStarted?.(name, input);

    // Enforced here too, not only in defs(): a model can name any tool it
    // likes, and an offered-but-not-executable list would be a fiction.
    if (!this.permitted(name)) {
      return {
        content: `tool not available in this conversation: ${name}`,
        isError: true,
      };
    }

    const assessment = registry.classify(name, input);

    if (assessment.tier === "risky") {
      const action = approvals.enqueue({
        tool: name,
        args: input,
        riskTier: "risky",
        reason: assessment.escalated ? "argument escalation" : "risky tool",
        ...(userId ? { userId } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      this.deps.onQueued?.(action);
      return {
        content: [
          `${QUEUED_PREFIX}${action.id}); not executed.`,
          `Tell the user to approve #${action.id}.`,
          "Do not re-call this tool until you receive an approval result.",
          "After approval the harness will resume you with the result; continue the plan then.",
        ].join(" "),
        isError: false,
      };
    }

    // Safe: inject secrets just before execution, then run and audit.
    const injected = injectSecrets(input, secrets);
    const result = await registry.execute(name, injected);
    audit.record({
      tool: name,
      args: input, // pre-injection; AuditLog also redacts defensively
      result: result.content,
      isError: result.isError,
      riskTier: "safe",
      ...(userId ? { userId } : {}),
    });
    this.deps.onExecuted?.(name, result);
    return result;
  }
}
