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
   * Hard allow-list of tool name prefixes for this conversation. When set, no
   * other tool is offered or executed. Unlike scope tags this withholds rather
   * than merely hides, which is what makes a scoped agent meaningfully scoped.
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
  constructor(private readonly deps: GuardedToolsDeps) {}

  /** Does this tool survive the conversation's allow-list? */
  private permitted(name: string): boolean {
    const { allow, grant, registry } = this.deps;
    if (registry.isRestricted(name)) return (grant ?? []).includes(name);
    if (!allow || allow.length === 0) return true;
    return allow.some((prefix) => name === prefix || name.startsWith(`${prefix}.`));
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

  async execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecution> {
    const { registry, secrets, audit, approvals, userId } = this.deps;

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
      });
      this.deps.onQueued?.(action);
      return {
        content: [
          `queued for approval (pending #${action.id}); not executed.`,
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
    return result;
  }
}
