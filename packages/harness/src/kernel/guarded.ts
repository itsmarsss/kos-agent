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

  defs(): ReturnType<ToolRegistry["defs"]> {
    const { registry, scopeTags, toolLimit } = this.deps;
    const all = registry.defs();

    // Scoping exists for the many-modules case. While every tool still fits
    // under the cap, narrowing only makes the offered set change shape from
    // turn to turn as the scope inference reads a different message, which
    // reads to the model as capabilities appearing and vanishing mid-task.
    const fitsWithoutScoping =
      toolLimit === undefined || registry.size <= toolLimit;
    if (fitsWithoutScoping || !scopeTags || scopeTags.length === 0) {
      return toolLimit !== undefined ? all.slice(0, toolLimit) : all;
    }

    return registry.scopedDefs({
      tags: scopeTags,
      ...(toolLimit !== undefined ? { limit: toolLimit } : {}),
    });
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecution> {
    const { registry, secrets, audit, approvals, userId } = this.deps;
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
