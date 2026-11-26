import { APPROVED_PREFIX, AUTO_DECIDER, DENIED_PREFIX, LAPSED_PREFIX, summarizeAction, type ChatMode } from "@kos/shared";

export { isUndone } from "@kos/shared";

import type { ToolBox } from "../agent/loop.js";
import type { ToolExecution, ToolRegistry } from "../agent/registry.js";
import { defang, type HeardWords } from "../models/heard.js";
import type { AuditLog } from "../ops/audit.js";
import type { ApprovalQueue, PendingAction } from "../ops/approvals.js";
import type { Caller, PermissionContext } from "../ops/permissions.js";
import { withBeyondAuto } from "../risk/beyondauto.js";
import { learnable } from "../risk/learned.js";
import { Taint, TAINT_REASON, taintBars, taintRaises, type TaintBar } from "../risk/taint.js";
import type { RiskAssessment } from "../risk/tiers.js";
import { readFrom } from "../risk/untrusted.js";
import { hasSecretRef, placeSecrets, secretsNamed } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import { allowsTool, approvedAs, attendance, caller, guested, onSite, origin, ownership, scheduled, tainting, toolScope, turn, turnStop, underAuto, type GuestOrigin, type TurnOrigin } from "./caller.js";

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
  /**
   * True when the turn began from the owner's own words in this chat: not a
   * dispatch, a handoff, a trail, an aside or a resumed approval. Auto
   * covers only these.
   */
  ownWords?: boolean;
  /** The job whose run this is, for a schedule's run; see `scheduled`. */
  scheduled?: number;
  /** When that job was made: a consent learned under its id before then was another job's. */
  scheduledSince?: number;
  /** The guest's room, for a turn a guest's words started or work they passed on; see `guested`. */
  guest?: GuestOrigin;
  /** The surface the turn's words arrived on, and those words; see `origin`. */
  origin?: TurnOrigin;
  /**
   * What the turn has read that the owner did not write (risk/taint.ts):
   * marked as calls answer, carried to work the turn passes on. Its own
   * when not given, starting clean.
   */
  taint?: Taint;
  /** Table-name prefixes of projects a guest may write in: rows read from them taint the turn. */
  guestTables?: () => readonly string[];
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
    /** A yes learned for this caller alone: the job's consent, or the same step a moment after the owner approved it here. */
    learned?(tool: string, input: Record<string, unknown>, who: Caller, context?: PermissionContext): "job" | "burst" | false;
    /** Hold the owner's yes to this call for the same step in this chat, a short while. */
    holdBurst?(conversationId: string, tool: string, input: Record<string, unknown>, context?: PermissionContext): boolean;
  };

  /** What the caller knows about a call that its arguments do not: the browser's site. */
  permissionContext?: (tool: string) => PermissionContext | undefined;
  /** What the owner said since the last call, while this turn runs: handed to the model with this call's result. */
  heard?: () => HeardWords | undefined;
  /**
   * The owner let this call run without asking, as a remembered decision
   * does: "site" only on the site its tab is on now (a session allowed for
   * this site's steps). A chat set to Auto is `chatMode`.
   */
  autoApproves?: (tool: string, context?: PermissionContext) => "site" | false;
  /**
   * The chat's mode, read at each call. Auto lets a risky call run without
   * asking, decided by auto mode, within what `autoCovers` allows.
   */
  chatMode?: () => ChatMode;
  /** Whether the kill switch is thrown: Auto lets nothing through meanwhile. */
  halted?: () => boolean;
  /** Told when Auto lets a call run, so the turn's answer can say it went ahead under Auto. */
  onAutoRan?: () => void;
  /**
   * What the call would act on puts it beyond Auto, read only once Auto
   * would otherwise cover it: a browser step on a checkout page, which its
   * arguments alone cannot show. The reason, or undefined.
   */
  beyondAutoNow?: (tool: string, input: Record<string, unknown>) => Promise<string | undefined>;
  /** Whether a call allowed on `site` alone sets out for another, so it is asked about instead. */
  leavesSite?: (tool: string, input: Record<string, unknown>, site: string) => boolean;
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
  /** Called as a call's tool begins to run, past any approval; what it answers is called once the tool has ended. */
  running?: (tool: string) => (() => void) | undefined;
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

/**
 * The result for an ask the owner denied, or that lapsed unanswered: what
 * the model is told of an ask that came to nothing, plain and final.
 *
 * It read "not approved (pending #1)", and with "pending" in the result the
 * model told the owner the delete was still waiting on them, a moment after
 * they had said no. Nothing here names an id to wait on. The prefixes are
 * `@kos/shared`'s, so a surface reads the outcome from the same words.
 */
export function undoneResult(decision: "denied" | "expired", what: string): string {
  return decision === "denied"
    ? `${DENIED_PREFIX}${what}. It was not done. Do not retry or ask again in this turn unless they say so. Tell them in one line that you did not do it.`
    : `${LAPSED_PREFIX}${what}. Do not retry it in this turn. Tell the owner in one line that you did not do it.`;
}

/** An approved call's own result, said to be approved so the model reports it rather than waiting on it. */
export function approvedResult(result: ToolExecution): ToolExecution {
  const head = result.isError ? `${APPROVED_PREFIX}; it ran and failed:` : `${APPROVED_PREFIX}, and it ran:`;
  return { ...result, content: `${head}\n${result.content}` };
}

/** Who the audit says let a call run that a tool's own grant covered (a secret's yes kept for a site or a turn). */
export const GRANT_DECIDER = "grant";

/**
 * The reason a turn's stop carries when the kill switch stopped it, so the
 * asks it waited on say so. An AbortError still, for whatever the signal
 * reaches (a fetch, the SDK) that reads its reason as one.
 */
export const KILL_SWITCH_STOP = new DOMException("The kill switch was thrown", "AbortError");

/** How a call auto mode let through reads to the model, so it says it went ahead under Auto. */
export const AUTO_PREFIX = "Ran under Auto, without asking the owner (this chat is set to Auto; say so when you report it):";

/** A call auto mode let through, said to be so. */
export function autoResult(result: ToolExecution): ToolExecution {
  return { ...result, content: `${AUTO_PREFIX}${result.isError ? " it failed." : ""}\n${result.content}` };
}

/** What a chat's Auto mode is weighed against for one risky call. */
export interface AutoCall {
  mode: ChatMode | undefined;
  assessment: RiskAssessment;
  /** The turn began from the owner's own words in this chat: not a schedule, a guest, a dispatch, a handoff or a resumed approval. */
  ownWords: boolean;
  /** The call's input names a secret: placing one asks every time. */
  secret: boolean;
  /** A tool of the browser's family that asks every time (script in a page, a handoff). */
  strict: boolean;
  halted: boolean;
}

/**
 * Whether a chat's Auto mode lets a risky call run without asking. Never
 * with the kill switch thrown, for a turn the owner did not start in this
 * chat, for what asks every time, for what a rule puts beyond Auto (money,
 * deleting outside the workspace), or for a session's start unless the
 * owner let Auto start sessions. Refusals and Stop are settled before this.
 */
export function autoCovers(call: AutoCall): boolean {
  const { mode, assessment } = call;
  if (mode?.mode !== "auto" || call.halted || !call.ownWords || call.strict || call.secret) return false;
  if (assessment.tier !== "risky" || assessment.asksAlways || assessment.beyondAuto) return false;
  return !assessment.startsSession || mode.sessions === true;
}

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
 *  3. injects `{{secret:name}}` references at call time, only into the slots
 *     a tool declared (model never sees keys), refusing them anywhere else,
 *  4. executes safe calls and records a redacted audit entry,
 *  5. scrubs every secret value from what a call answers, before the model,
 *     the audit, the shelf or a reader sees it.
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

  /** What this turn has read that the owner did not write. */
  readonly taint: Taint;

  constructor(private readonly deps: GuardedToolsDeps) {
    this.taint = deps.taint ?? new Taint();
  }

  /** Mark the turn with what a call that ran read, if it read outside text. */
  private noteRead(name: string, input: Record<string, unknown>, result: ToolExecution): void {
    const site = name.startsWith("browser.") ? this.deps.permissionContext?.(name)?.browser?.site : undefined;
    const source = readFrom(name, input, result.content, { ...(site ? { site } : {}), guestTables: this.deps.guestTables?.() ?? [] }) ?? this.deps.registry.untrusted(name, input, result);
    if (source) this.taint.mark(source);
  }

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
    return allowsTool(allow, name);
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
      calling.then(tell, (err: unknown) => tell({ content: this.deps.secrets.scrub(err instanceof Error ? err.message : String(err)), isError: true }));
      return { content: STOPPED_RESULT, isError: true };
    }
    const kept = this.deps.shelve && !called.isError ? { ...called, content: await this.deps.shelve(name, input, called.content, this.cutHuge) } : called;
    // A result's own text never passes for the owner's line; their real words ride beside it.
    const result = { ...kept, content: defang(kept.content) };
    const heard = signal?.aborted ? undefined : this.deps.heard?.();
    return heard ? { ...result, heard } : result;
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
    // Set for every call, cleared when this turn is no schedule's: a turn a
    // scheduled run started (a dispatch, a handoff) must not inherit its job.
    const job = this.deps.scheduled;
    const guest = this.deps.guest;
    // Who a vault secret's policy judges this call for.
    const who = { conversationId: conversationId ?? null, attended, guest: guest !== undefined };
    const scope = { allow: this.deps.allow };
    const taint = this.taint;
    const within = <T>(work: () => Promise<T>): Promise<T> =>
      tainting.run(taint, () => toolScope.run(scope, () => scheduled.run(job, () => guested.run(guest, () => attendance.run(attended, () => ownership.run(owner, () => placed(() => (conversationId ? caller.run(conversationId, () => inTurn(work)) : inTurn(work)))))))));
    const run = async (n: string, i: Record<string, unknown>, site?: string, yes?: { id: number; by: string }): Promise<ToolExecution> => {
      // Placed at the last moment, so a key changed while the owner was asked is the one sent.
      const placed = placeSecrets(n, i, registry.secretSlots(n), secrets, who);
      if ("refused" in placed) return { content: placed.refused, isError: true };
      started.ran = true;
      const ended = this.deps.running?.(n);
      try {
        const execute = (): Promise<ToolExecution> => (site ? onSite.run(site, () => registry.execute(n, placed.input)) : registry.execute(n, placed.input));
        const done = await within(() => (yes ? approvedAs.run(yes, execute) : execute()));
        const scrubbed = { ...done, content: secrets.scrub(done.content) };
        this.noteRead(n, placed.input, scrubbed);
        return scrubbed;
      } finally {
        ended?.();
      }
    };

    /*
     * A call refused before it ran, on the record as a failed step.
     *
     * Kept out of the audit, a refusal was no step at all: a job whose
     * shell call its allow-list refused, which then ended quietly, read as
     * a clean run. Recorded with what the model asked for; secrets in it
     * are redacted by the log as any call's are.
     */
    const refuse = (content: string, args: Record<string, unknown> = called): ToolExecution => {
      audit.record({
        tool: name,
        args,
        result: content,
        isError: true,
        ...(turnId ? { turnId } : {}),
        ...(userId ? { userId } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      return { content, isError: true };
    };

    const repeated = this.repeatGuard(name, called);
    if (repeated) return refuse(repeated);

    this.deps.onStarted?.(name, called);

    // Nothing runs while the kill switch is thrown, safe or not: a turn or a job still going when it was thrown does no more.
    if (this.deps.halted?.()) return refuse("KOS is halted (kill switch engaged): nothing runs until the owner resumes it.");

    // Enforced here too, not only in defs(): a model can name any tool it
    // likes, and an offered-but-not-executable list would be a fiction.
    if (!this.permitted(name)) return refuse(`tool not available in this conversation: ${name}`);

    // Refused before it is judged: a rule that refuses is the fence, and an
    // ask would only invite the owner to open a gate the harness keeps shut.
    // Judged inside the turn's stores, so a rule that asks who is calling hears this turn.
    const refused = await within(async () => registry.refusal(name, called));
    if (refused) return refuse(refused);

    // Judged, asked about and run as stamped: what the owner says yes to is
    // what runs, and the call can check it still holds.
    const input = await within(async () => registry.stamp(name, called));
    /** The audit's record of the call once it ran: as much of it as its tool keeps. */
    const audited = (ran: ToolExecution): { args: Record<string, unknown>; result: string; isError: boolean } => {
      const kept = registry.audited(name, input, ran);
      return { args: kept.args, result: kept.result, isError: ran.isError };
    };

    // A secret where its tool declared no slot for one, or bound for another host: refused before anyone is asked.
    const misplaced = placeSecrets(name, input, registry.secretSlots(name), secrets, who);
    if ("refused" in misplaced) return refuse(misplaced.refused, input);

    /*
     * A call that sends a secret asks the owner every time, until the
     * secrets tools bring their own tier: no remembered yes and no Auto
     * covers it, and the ask names the secret and the host it goes to.
     * Judged inside the turn's stores: a call's reach depends on whose turn it is.
     */
    const using = secretsNamed(input);
    const sends = using.length > 0 ? `sends secret ${using.join(", ")} to ${registry.secretSlots(name)?.host?.(input) ?? "an unknown host"}` : undefined;
    const classified: RiskAssessment = sends ? { tier: "risky", escalated: true, reason: sends, asksAlways: true } : await within(async () => registry.classify(name, input));
    // A call that names a secret anywhere asks every time: Auto and remembered decisions never cover it.
    const secret = hasSecretRef(input);
    /*
     * A turn that has read what the owner did not write: a call that would
     * open a site it has not been on or set up work for later asks, and no
     * saved yes covers one that reaches outside (risk/taint.ts).
     */
    const tabSite = this.deps.permissionContext?.(name)?.browser?.site;
    const said = owner && this.deps.ownWords === true ? from?.said : undefined;
    const judged = { tool: name, input, secret, ...(tabSite ? { site: tabSite } : {}), ...(said ? { said } : {}) };
    const raised = classified.tier === "safe" ? taintRaises(judged, taint) : false;
    const lifted: RiskAssessment = raised ? { tier: "risky", escalated: true, reason: raised, neverLearned: true } : classified;
    // What KOS's own rules put beyond a chat's Auto, beside what the tool's own says.
    const assessment = withBeyondAuto(lifted, name, input);
    const bar: TaintBar | false = raised ? { why: raised } : assessment.tier === "risky" ? taintBars({ ...judged, assessment }, taint) : false;

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
      if (unready) return refuse(unready, input);
      // A Stop while the owner was being asked: the turn has answered, and nothing runs for it now.
      // Not a refused step: a stopped turn is judged as stopped.
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
      // A call past the turn's own folder is judged as one: no rule made inside it covers the call.
      const given = this.deps.permissionContext?.(name);
      const context = assessment.reached ? { ...given, reached: true } : given;
      // A chat set to Auto, for the owner's own turn: decided by auto mode, kept in the Inbox as such, and said to the model.
      const mode = this.deps.chatMode?.();
      const covered = (!bar || bar.auto === true) && autoCovers({ mode, assessment, ownWords: owner && this.deps.ownWords === true, strict, secret, halted: this.deps.halted?.() === true });
      // Why Auto held back after all, from what the call would act on: said on the card, so the owner knows why it asked.
      const heldBack = covered ? await this.deps.beyondAutoNow?.(name, input).catch(() => "could not check the page for a checkout") : undefined;
      // Why a chat in Auto asks anyway, from its rules or what the call acts on: the card says so and offers no remembered yes.
      const beyond = heldBack ?? (mode?.mode === "auto" ? assessment.beyondAuto : undefined);
      if (covered && !heldBack) {
        const unready = await readyNow();
        if (unready) return unready;
        const settled = approvals.settled(
          {
            tool: name,
            args: input,
            riskTier: "risky",
            reason: assessment.reason ?? "risky tool",
            ...(userId ? { userId } : {}),
            ...(conversationId ? { conversationId } : {}),
            owner,
            attended,
            ...(context?.browser?.yours ? { yours: true } : {}),
          },
          AUTO_DECIDER,
          "auto",
        );
        this.deps.onAutoRan?.();
        const ran = await underAuto.run(true, () => run(name, input));
        audit.record({ tool: name, ...audited(ran), ...(turnId ? { turnId } : {}), riskTier: "risky", approvedBy: AUTO_DECIDER, decidedVia: "auto", approvalId: settled.id, ...(userId ? { userId } : {}) });
        this.deps.onExecuted?.(name, ran);
        return autoResult(ran);
      }
      // What asks every time is covered by no session's yes and no remembered decision either.
      const always = assessment.asksAlways === true || secret;
      // Only by a yes its own tool keeps (a secret's grant on this site, or for this turn): run, and audited as such.
      if (always && !bar && (await within(async () => registry.granted(name, input)))) {
        const granted = await run(name, input);
        audit.record({ tool: name, ...audited(granted), ...(turnId ? { turnId } : {}), riskTier: "risky", approvedBy: GRANT_DECIDER, decidedVia: "grant", ...(userId ? { userId } : {}), ...(conversationId ? { conversationId } : {}) });
        this.deps.onExecuted?.(name, granted);
        return granted;
      }
      // In a tainted turn, a call that reaches outside is the owner's to decide now: no session's yes or saved rule covers it.
      const session = !always && !bar && this.deps.autoApproves?.(name, context) === "site";
      const standing = session || (!always && !bar && this.deps.permissions?.allows(name, input, this.deps.projectSlug?.(), context) === true);
      // Learned from the owner's own decisions, never from what a turn read, and never for what may not be learned (risk/learned.ts).
      const learnedCall = { tool: name, input, assessment, guest: guest !== undefined, secret, strict, yours: context?.browser?.yours === true };
      const asker: Caller = { ...(conversationId ? { conversationId } : {}), ...(job !== undefined && this.deps.scheduledSince !== undefined ? { job: { id: job, since: this.deps.scheduledSince } } : {}) };
      const mayLearn = learnable(learnedCall);
      const learned = standing || always || !mayLearn || bar ? false : this.deps.permissions?.learned?.(name, input, asker, context) || false;
      // A browser step a learned yes would let through is read for a checkout first, as Auto's is: money is never learned.
      const pays = learned ? await this.deps.beyondAutoNow?.(name, input).catch(() => "could not check the page for a checkout") : undefined;
      const yes = standing || (learned !== false && !pays);
      // A yes kept for a site holds on that site alone: the run checks each step against it, and one setting out elsewhere asks.
      const bound = yes ? context?.browser?.site : undefined;
      const allowed = yes && !(bound !== undefined && this.deps.leavesSite?.(name, input, bound) === true);
      if (allowed) {
        const unready = await readyNow();
        if (unready) return unready;
        const allowedResult = await run(name, input, bound);
        audit.record({
          tool: name,
          ...audited(allowedResult),
          ...(turnId ? { turnId } : {}),
          riskTier: "risky",
          decidedVia: session ? "session" : standing ? "rule" : learned || "rule",
          ...(userId ? { userId } : {}),
          ...(conversationId ? { conversationId } : {}),
        });
        this.deps.onExecuted?.(name, allowedResult);
        return allowedResult;
      }
      // Named now, while the caller's situation is known: the rule a yes-
      // and-remember would keep, and a picture of the page a browser action
      // is aimed at, which the arguments alone cannot show.
      const named = always || beyond ? undefined : this.deps.permissions?.ruleFor?.(name, input, this.deps.projectSlug?.() ?? null, context);
      // A scheduled run's Always is kept for its job alone, for what a job may keep: a named shape. One that names the whole
      // tool (a skill run, an MCP tool) is the standing Always it always was, the owner's to press; nothing learned covers it.
      const rule = job === undefined ? named : named && mayLearn && !pays ? (named.scope !== null ? { ...named, job } : named) : undefined;
      // Said on the card where only the taint kept a saved yes from it: what asks every time, or is beyond Auto, says its own reason.
      const heldByTaint = bar !== false && !always && !beyond;
      const picture = await this.deps.pictureFor?.(name, input).catch(() => undefined);
      const site = context?.browser?.site;
      const why = this.deps.whyFor?.(conversationId)?.trim();
      const placing = registry.secretAsk(name, input);
      // The picture takes a moment; a stop in it leaves nobody to show a card to.
      if (signal?.aborted) return { content: STOPPED_RESULT, isError: true };
      const action = approvals.enqueue({
        tool: name,
        args: input,
        riskTier: "risky",
        // The rule's own words first; the old labels only where a rule has none.
        reason: `${beyond ? `asked though the chat is in Auto: ${beyond}` : (assessment.reason ?? (assessment.escalated ? "argument escalation" : site ? `on ${site}` : "risky tool"))}${context?.browser?.yours ? ", in your Chrome" : ""}${heldByTaint ? (bar.why !== assessment.reason ? `; ${bar.why}, and ${TAINT_REASON}` : `; ${TAINT_REASON}`) : ""}`,
        ...(userId ? { userId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(rule ? { rule } : {}),
        ...(assessment.reached ? { reached: true } : {}),
        ...(beyond ? { beyondAuto: true } : {}),
        ...(picture ? { picture } : {}),
        ...(why ? { why } : {}),
        ...(placing ? { secret: placing } : {}),
        ...(taint.tainted ? { taint: taint.sources } : {}),
        owner,
        attended,
        ...(guest ? { guest } : {}),
        ...(job !== undefined ? { job } : {}),
        waits: this.deps.waitForApproval !== false,
        ...(context?.browser?.yours ? { yours: true } : {}),
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
      const lapse = (): void => void approvals.lapse(action.id, signal?.reason === KILL_SWITCH_STOP ? "kill-switch" : "stopped");
      signal?.addEventListener("abort", lapse, { once: true });
      if (signal?.aborted) lapse();
      const decision = await approvals.waitFor(
        action.id,
        this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_WAIT_MS,
      );
      signal?.removeEventListener("abort", lapse);
      this.deps.onDecided?.(action, decision);

      if (decision !== "approved") {
        return { content: undoneResult(decision === "denied" ? "denied" : "expired", summarizeAction(name, input)), isError: false };
      }

      // The owner's yes holds for the same step in this chat a short while: a burst of one kind of work asks once.
      // Not in a run nobody started (a schedule's): there Approve is for this run alone, and Always is the job's.
      if (attended && conversationId && mayLearn && !assessment.reached && !bar) this.deps.permissions?.holdBurst?.(conversationId, name, input, context);
      const unready = await readyNow();
      if (unready) return unready;
      const decided = approvals.get(action.id);
      const approvedRun = await run(name, input, undefined, { id: action.id, by: decided?.decidedBy ?? userId ?? "owner" });
      audit.record({
        tool: name,
        ...audited(approvedRun),
        ...(turnId ? { turnId } : {}),
        riskTier: "risky",
        decidedVia: decided?.decidedVia ?? null,
        approvalId: action.id,
        ...(userId ? { userId } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      this.deps.onExecuted?.(name, approvedRun);
      return approvedResult(approvedRun);
    }

    // Safe: run (secrets placed as it starts) and audit.
    const result = await run(name, input);
    audit.record({
      tool: name,
      ...audited(result), // pre-injection; AuditLog also redacts defensively
      ...(turnId ? { turnId } : {}),
      riskTier: "safe",
      ...(userId ? { userId } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
    this.deps.onExecuted?.(name, result);
    return result;
  }
}
