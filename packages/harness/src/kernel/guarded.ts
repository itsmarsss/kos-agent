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
  /** Decisions the owner has made before. A match runs without asking. */
  permissions?: { allows(tool: string, input: Record<string, unknown>, project?: string): boolean };
  /** The project the calling conversation belongs to, for scoping those decisions. */
  projectSlug?: () => string | undefined;
  /**
   * Called after a tool actually ran. Some tools change state the kernel holds
   * outside the database, and it has to hear about it.
   */
  onExecuted?: (tool: string, result: ToolExecution) => void;
  /** Called as a call begins, so a reader can see the step it is on. */
  onStarted?: (tool: string, input: Record<string, unknown>) => void;
  /** Called once the owner has decided about a queued call. */
  onDecided?: (action: PendingAction, status: string) => void;
  /** How long to hold a suspended turn before treating silence as refusal. */
  approvalTimeoutMs?: number;
  /**
   * Wait for the decision, rather than queueing and moving on.
   *
   * True for a turn somebody is watching: the owner is there, the answer is
   * on screen, and holding the call keeps one turn and one bubble. False for
   * work that runs unattended, where nobody is going to decide within the
   * next half hour and waiting only holds a queue slot for that long.
   */
  waitForApproval?: boolean;
}

/**
 * A queued risky call reports success, because nothing went wrong: it simply
 * has not happened yet. Readers need to tell those apart from a call that ran,
 * so the message carries a stable prefix both the model and the transcript
 * parse, rather than each guessing from prose.
 */
export const QUEUED_PREFIX = "queued for approval (pending #";

/** The other end of the same decision, so a reader can tell them apart. */
export const DENIED_PREFIX = "not approved (pending #";

/**
 * How long a turn will hold, waiting on the owner, before treating silence as
 * a refusal. Long enough to walk away from the screen; short enough that a
 * conversation is not wedged for a day.
 */
const DEFAULT_APPROVAL_WAIT_MS = 30 * 60_000;

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
    // A module may be for certain projects. Its tools exist only in those
    // projects' conversations: withheld, not hidden, so the model is never
    // offered a tool it cannot call.
    const projects = registry.tagsOf(name).filter((t) => t.startsWith("project:")).map((t) => t.slice("project:".length));
    if (projects.length > 0) {
      const here = this.deps.projectSlug?.();
      if (!here || !projects.includes(here)) return false;
    }
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

  /**
   * Every tool this conversation may reach, offered every turn.
   *
   * This used to narrow the set by tags inferred from the message once the
   * registry passed a cap, so tools appeared and vanished between turns as
   * the inference read each message differently. With a few dozen tools the
   * cap never engaged, and a model that cannot see a tool reports the job
   * done by other means. Everything permitted is simply offered.
   */
  defs(): ReturnType<ToolRegistry["defs"]> {
    const { registry, grant } = this.deps;
    const granted = grant?.length ? registry.restrictedDefs(grant) : [];
    return [...registry.defs(), ...granted].filter((d) => this.permitted(d.name));
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
      /*
       * Already decided.
       *
       * Measured on a real workspace, 96 of 97 approvals were granted. A
       * decision the owner has made for this shape, in this project, is not
       * asked again: the call runs as an approved one would, and the audit
       * shows it ran as risky.
       */
      if (this.deps.permissions?.allows(name, input, this.deps.projectSlug?.())) {
        const allowedResult = await registry.execute(name, injectSecrets(input, secrets));
        audit.record({
          tool: name,
          args: input,
          result: allowedResult.content,
          isError: allowedResult.isError,
          riskTier: "risky",
          ...(userId ? { userId } : {}),
        });
        this.deps.onExecuted?.(name, allowedResult);
        return allowedResult;
      }
      const action = approvals.enqueue({
        tool: name,
        args: input,
        riskTier: "risky",
        reason: assessment.escalated ? "argument escalation" : "risky tool",
        ...(userId ? { userId } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      this.deps.onQueued?.(action);

      /*
       * Nobody is waiting on an unattended run, so it does not wait either.
       *
       * A scheduled job that asked for something risky suspended here for the
       * approval window -- half an hour by default -- holding its place in
       * the work queue the whole time, and then failed by timeout because the
       * owner was asleep. The action is queued, the run says so and ends. The
       * decision executes it later, which is what approve() does for any
       * request nothing is waiting on.
       */
      if (this.deps.waitForApproval === false) {
        return {
          content: [
            `Queued for approval (#${action.id}).`,
            "Nothing was done. It runs if the owner approves it.",
          ].join(" "),
          isError: false,
        };
      }

      /*
       * Suspend here rather than end the turn.
       *
       * Returning "queued" told the model to stop and left the harness to
       * start a fresh turn on approval. That fresh turn cleared the live view,
       * ran the tool a second time under its own bubble, and made several
       * calls queued at once impossible to resolve together. Waiting keeps one
       * turn, one bubble, and one result: the owner's decision arrives and the
       * call carries on from where it was.
       */
      const decision = await approvals.waitFor(
        action.id,
        this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_WAIT_MS,
      );
      this.deps.onDecided?.(action, decision);

      if (decision !== "approved") {
        return {
          content: [
            `${DENIED_PREFIX}${action.id}).`,
            "The owner did not approve it, so nothing was done.",
            "Do not try it again. Say what you would have done and stop, or",
            "offer something that does not need it.",
          ].join(" "),
          isError: false,
        };
      }

      const approvedInput = injectSecrets(input, secrets);
      const approvedResult = await registry.execute(name, approvedInput);
      audit.record({
        tool: name,
        args: input,
        result: approvedResult.content,
        isError: approvedResult.isError,
        riskTier: "risky",
        ...(userId ? { userId } : {}),
      });
      this.deps.onExecuted?.(name, approvedResult);
      return approvedResult;
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
