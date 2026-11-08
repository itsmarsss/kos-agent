import type { ToolBox } from "../agent/loop.js";
import type { ToolExecution, ToolRegistry } from "../agent/registry.js";
import type { AuditLog } from "../ops/audit.js";
import type { ApprovalQueue, PendingAction } from "../ops/approvals.js";
import type { PermissionContext } from "../ops/permissions.js";
import { injectSecrets } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import { attendance, caller, origin, ownership, turn, turnStop, type TurnOrigin } from "./caller.js";

export interface GuardedToolsDeps {
  /** A big result set aside as it comes back: whole with its handle, or its start and an outline when huge (in an SDK query). */
  shelve?: (tool: string, input: Record<string, unknown>, content: string, huge: boolean) => Promise<string>;
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
  /** The turn making the call, so what one turn may reach stays that turn's. */
  turnId?: string;
  /** False when the owner did not start this turn (a schedule, a guest); see `attendance`. */
  attended?: boolean;
  /** True for the owner's own turn alone; see `ownership`. */
  owner?: boolean;
  /** The surface the turn's words arrived on, and those words; see `origin`. */
  origin?: TurnOrigin;
  /**
   * The turn's stop. Once it aborts, a call that is running answers at once
   * (what it started is told through `turnStop`, and its own end is still
   * audited when it comes), an ask it is waiting on lapses, and no new call
   * starts.
   */
  signal?: AbortSignal;
  /** Decisions the owner has made before. A match runs without asking. */
  permissions?: {
    allows(tool: string, input: Record<string, unknown>, project?: string, context?: PermissionContext): boolean;
    ruleFor?(tool: string, input: Record<string, unknown>, project: string | null, context?: PermissionContext): { tool: string; scope: string | null; project: string | null } | undefined;
  };
  /** What the caller knows about a call that its arguments do not: the browser's site. */
  permissionContext?: (tool: string) => PermissionContext | undefined;
  /** What the owner said since the last call, while this turn runs: handed to the model with this call's result. */
  heard?: () => string | undefined;
  /** The owner set this chat to act without asking, for this call: runs as a remembered decision does. */
  autoApproves?: (tool: string, context?: PermissionContext) => boolean;
  /** A picture of what a call would act on, for the approval; base64 JPEG. */
  pictureFor?: (tool: string, input: Record<string, unknown>) => Promise<string | undefined>;
  /**
   * What the calling conversation's model said since its last tool call:
   * the sentence the ask belongs to, so an approval reads as "I'll clear
   * the build folder so the rebuild is clean" and then the command, not the
   * command alone.
   */
  whyFor?: (conversationId?: string) => string | undefined;
  /** The project the calling conversation belongs to, for scoping those decisions. */
  projectSlug?: () => string | undefined;
  /**
   * Called after a tool actually ran. Some tools change state the kernel holds
   * outside the database, and it has to hear about it.
   */
  onExecuted?: (tool: string, result: ToolExecution) => void;
  /**
   * A call that ran on after its turn was stopped, and has now ended: its
   * real outcome, so the chat's next turn knows what the stopped one left.
   */
  onFinishedAfterStop?: (tool: string, result: ToolExecution) => void;
  /** Called as a call begins, so a reader can see the step it is on. */
  onStarted?: (tool: string, input: Record<string, unknown>) => void;
  /**
   * Made ready before a call is judged, in the caller's context: a session
   * its tool needs, started where the owner allows it (the side panel's
   * Chrome), so the call is judged against where it will run. Words saying
   * why it cannot be readied refuse the call.
   */
  prepare?: (tool: string) => Promise<string | undefined>;
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
 * What a call answers when the owner stopped the turn under it. Stop only
 * stops the waiting: the call may have done its work, or still be doing it.
 */
export const STOPPED_RESULT = "Stopped: the owner pressed Stop before this answered. It may still have run, so check before doing it again.";

/** The chat's line for a call that ended after its turn was stopped: what finished, and how. */
export function finishedAfterStop(tool: string, result: ToolExecution): string {
  const said = result.content.replace(/\s+/g, " ").trim();
  const gist = said.length > 300 ? `${said.slice(0, 300)}...` : said;
  return `After Stop, ${tool} finished ${result.isError ? "with an error" : "and succeeded"}${gist ? `: ${gist}` : "."}`;
}

/** The work's own end, or undefined the moment the signal aborts; its listener goes with it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve(undefined);
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

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

  /**
   * Set by an SDK query: there a result over the SDK's file limit is cut to
   * its start, an outline and a handle, since the SDK would otherwise write it
   * to a file the model then reads piecemeal. Elsewhere results come whole.
   */
  cutHuge = false;

  constructor(private readonly deps: GuardedToolsDeps) {}

  /** Does this tool survive the conversation's allow-list? */
  private permitted(name: string): boolean {
    const { allow, grant, registry } = this.deps;
    if (registry.isRestricted(name)) return (grant ?? []).includes(name);
    // A grant is a grant whether or not the tool is restricted: the
    // orchestrator's allow-list is "memory" plus what it is handed, and the
    // Discord reading tools, unrestricted so a blob may use them, were
    // falling through to the allow-list and vanishing from its channel turns.
    if (grant?.includes(name)) return true;
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

  /**
   * One call, and with its result whatever the owner said meanwhile: a tool
   * result is the one thing a running turn reads between steps, on either
   * engine, so it is where words said mid-turn are heard.
   */
  async execute(name: string, input: Record<string, unknown>): Promise<ToolExecution> {
    const { signal } = this.deps;
    if (signal?.aborted) return { content: STOPPED_RESULT, isError: true };
    const started = { ran: false };
    const calling = this.call(name, input, started);
    /*
     * A stop answers now rather than when the call ends.
     *
     * The turn waited for whatever was running: a minute of python, a device
     * that had not answered. The call goes on to its own end (a program is
     * killed through turnStop, and what it did is audited when it ends), but
     * the turn is not held for it. Words the owner said meanwhile are not
     * taken: nothing will read this result, so they run as a turn of their own.
     */
    const called = signal ? await untilAborted(calling, signal) : await calling;
    if (!called) {
      // Only a call that reached its tool has an outcome worth telling; an ask that lapsed did nothing.
      const tell = (result: ToolExecution): void => {
        if (started.ran) this.deps.onFinishedAfterStop?.(name, result);
      };
      calling.then(tell, (err: unknown) => tell({ content: err instanceof Error ? err.message : String(err), isError: true }));
      return { content: STOPPED_RESULT, isError: true };
    }
    const result = this.deps.shelve && !called.isError ? { ...called, content: await this.deps.shelve(name, input, called.content, this.cutHuge) } : called;
    const said = signal?.aborted ? undefined : this.deps.heard?.();
    return said ? { ...result, content: `${result.content}${said}` } : result;
  }

  private async call(
    name: string,
    called: Record<string, unknown>,
    started: { ran: boolean },
  ): Promise<ToolExecution> {
    const { registry, secrets, audit, approvals, userId, conversationId } =
      this.deps;

    // Every handler runs inside the caller store, so a tool that asks which
    // conversation is calling gets this one, not whichever turn started last.
    const attended = this.deps.attended !== false;
    const owner = attended && this.deps.owner === true;
    const { turnId, signal } = this.deps;
    const stoppable = <T>(work: () => Promise<T>): Promise<T> => (signal ? turnStop.run(signal, work) : work());
    const inTurn = <T>(work: () => Promise<T>): Promise<T> => (turnId ? turn.run(turnId, () => stoppable(work)) : stoppable(work));
    const from = this.deps.origin;
    const placed = <T>(work: () => Promise<T>): Promise<T> => (from ? origin.run(from, work) : work());
    const within = <T>(work: () => Promise<T>): Promise<T> =>
      attendance.run(attended, () => ownership.run(owner, () => placed(() => (conversationId ? caller.run(conversationId, () => inTurn(work)) : inTurn(work)))));
    const run = (n: string, i: Record<string, unknown>): Promise<ToolExecution> => {
      started.ran = true;
      return within(() => registry.execute(n, i));
    };

    const repeated = this.repeatGuard(name, called);
    if (repeated) return { content: repeated, isError: true };

    this.deps.onStarted?.(name, called);

    // Enforced here too, not only in defs(): a model can name any tool it
    // likes, and an offered-but-not-executable list would be a fiction.
    if (!this.permitted(name)) {
      return {
        content: `tool not available in this conversation: ${name}`,
        isError: true,
      };
    }

    // Refused before it is judged: a rule that refuses is the fence, and an
    // ask would only invite the owner to open a gate the harness keeps shut.
    const refused = registry.refusal(name, called);
    if (refused) return { content: refused, isError: true };

    // Judged, asked about and run as stamped: what the owner says yes to is
    // what runs, and the call can check it still holds.
    const input = registry.stamp(name, called);

    const assessment = registry.classify(name, input);

    /*
     * Readied before it is judged on where it runs: a browser call from the
     * side panel is judged on the owner's tab, once the owner let KOS have
     * it. Not for a call that cannot run now whatever the session: a risky
     * one in a turn that only queues, or one of the strict tools, which no
     * rule covers and which the owner is asked about first, so a no there
     * never follows a prompt for a session.
     */
    const ready = async (): Promise<ToolExecution | undefined> => {
      const unready = this.deps.prepare ? await within(() => this.deps.prepare!(name)).catch((err: unknown) => (err instanceof Error ? err.message : String(err))) : undefined;
      if (unready) return { content: unready, isError: true };
      // A Stop while the owner was being asked: the turn has answered, and nothing runs for it now.
      if (signal?.aborted) return { content: STOPPED_RESULT, isError: true };
      return undefined;
    };
    const queuesOnly = assessment.tier === "risky" && this.deps.waitForApproval === false;
    const strict = assessment.tier === "risky" && this.deps.permissionContext?.(name)?.browser?.strict?.includes(name) === true;
    if (!queuesOnly && !strict) {
      const refused = await ready();
      if (refused) return refused;
    }
    /** Readied once the owner said yes, for a call that was asked about before it was readied. */
    const readyNow = (): Promise<ToolExecution | undefined> => (strict || queuesOnly ? ready() : Promise.resolve(undefined));

    if (assessment.tier === "risky") {
      /*
       * Already decided.
       *
       * Measured on a real workspace, 96 of 97 approvals were granted. A
       * decision the owner has made for this shape, in this project, is not
       * asked again: the call runs as an approved one would, and the audit
       * shows it ran as risky.
       */
      const context = this.deps.permissionContext?.(name);
      if (this.deps.permissions?.allows(name, input, this.deps.projectSlug?.(), context) || this.deps.autoApproves?.(name, context)) {
        const unready = await readyNow();
        if (unready) return unready;
        const allowedResult = await run(name, injectSecrets(input, secrets));
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
      // Named now, while the caller's situation is known: the rule a yes-
      // and-remember would keep, and a picture of the page a browser action
      // is aimed at, which the arguments alone cannot show.
      const rule = this.deps.permissions?.ruleFor?.(name, input, this.deps.projectSlug?.() ?? null, context);
      const picture = await this.deps.pictureFor?.(name, input).catch(() => undefined);
      const site = context?.browser?.site;
      const why = this.deps.whyFor?.(conversationId)?.trim();
      // The picture takes a moment; a stop in it leaves nobody to show a card to.
      if (signal?.aborted) return { content: STOPPED_RESULT, isError: true };
      const action = approvals.enqueue({
        tool: name,
        args: input,
        riskTier: "risky",
        // The rule's own words first; the old labels only where a rule has none.
        reason: `${assessment.reason ?? (assessment.escalated ? "argument escalation" : site ? `on ${site}` : "risky tool")}${context?.browser?.yours ? ", in your Chrome" : ""}`,
        ...(userId ? { userId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(rule ? { rule } : {}),
        ...(picture ? { picture } : {}),
        ...(why ? { why } : {}),
        owner,
        attended,
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
      /*
       * A stop while waiting lapses the ask, as the wait running out does: a
       * turn that has gone has nothing to carry on with, and a yes given
       * later would run the call for nobody.
       */
      const lapse = (): void => void approvals.lapse(action.id, "stopped");
      signal?.addEventListener("abort", lapse, { once: true });
      if (signal?.aborted) lapse();
      const decision = await approvals.waitFor(
        action.id,
        this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_WAIT_MS,
      );
      signal?.removeEventListener("abort", lapse);
      this.deps.onDecided?.(action, decision);

      if (decision !== "approved") {
        return {
          content: [
            `${DENIED_PREFIX}${action.id}).`,
            decision === "expired" ? "Nobody decided within the wait, so nothing was done." : "The owner did not approve it, so nothing was done.",
            "Do not try it again. Say what you would have done and stop, or",
            "offer something that does not need it.",
          ].join(" "),
          isError: false,
        };
      }

      const unready = await readyNow();
      if (unready) return unready;
      const approvedInput = injectSecrets(input, secrets);
      const approvedResult = await run(name, approvedInput);
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
    const result = await run(name, injected);
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
