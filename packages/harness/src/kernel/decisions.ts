import { PRIVATE_TOOLS, summarizeAction, toolWords, typedVia, usesSecret, type ActionHome, type AskDetached, type DecidedVia, type LapseVia } from "@kos/shared";

import type { DecidedHow, PendingAction } from "../ops/approvals.js";
import type { PermissionContext } from "../ops/permissions.js";
import { SHARED_LANE } from "../ops/queue.js";
import type { ToolRisk } from "../risk/tiers.js";
import { placeSecrets, type SecretSlots } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import { approvedAs, attendance, caller, guested, ownership } from "./caller.js";
import { primarySessionId } from "./session.js";

/**
 * Carrying out the owner's decision on a queued action.
 *
 * Usually the turn that asked is still waiting, and the decision just
 * releases it. The rest of this is the recovery path: an action nobody is
 * waiting on any more, which is what a pending row becomes when the host
 * restarts under it. Then the action is run here, audited, and the
 * conversation it came from is resumed with the result, so the owner gets
 * an answer rather than a row that quietly flipped to approved.
 */

/** The secrets tools: asked about while the turn waits, and never run for a turn that has gone. */
const SECRETS_PREFIX = "secrets.";

/** A build's permission requests are decided here and performed by the build itself. */
export const BUILD_ACTION_PREFIX = "build.";

/**
 * What becomes of an ask once no turn waits on its answer: it runs when
 * approved, with its result told to its chat, or it lapses.
 *
 * A Maintenance delete asked at noon, its turn cut by a restart, was
 * approved two hours later and ran at once with nobody reading the result.
 * So an ask a turn held for lapses with that turn, unless its tool says its
 * effect is the point on its own (ToolRisk.detached "runs"). An ask nothing
 * ever waited on (a schedule's, raised to be decided later) runs when
 * approved, as it was raised to. A secrets tool's, or one whose tool runs
 * only for its turn (ToolRisk.detached "never"), never runs detached.
 * Whichever runs detached, its card warns so before any yes.
 */
export function orphanFate(action: Pick<PendingAction, "tool" | "waits">, detached: ToolRisk["detached"]): "runs" | "lapses" {
  if (action.tool.startsWith(SECRETS_PREFIX) || detached === "never") return "lapses";
  if (!action.waits) return "runs";
  return detached === "runs" ? "runs" : "lapses";
}

/**
 * Why a pending ask would run with no turn waiting on it, for its card's
 * warning: its chat stopped and it was kept to run detached, or nothing
 * ever waited (a schedule's). None for a build's, which its build waits on.
 */
export function detachedAs(action: Pick<PendingAction, "tool" | "waits" | "detachedAt">): AskDetached | undefined {
  if (action.detachedAt !== null) return "stopped";
  return action.waits || action.tool.startsWith(BUILD_ACTION_PREFIX) ? undefined : "unwaited";
}

/** How a resume begins, so a reader can show it as a note rather than as the owner's words. */
export const RESUME_HEAD = "System: the owner decided on";

/** One decided action, as the resumed turn is told it: what it was, and what came of it. */
export function decidedLine(id: number, tool: string, args: string, outcome: { approved: true; isError: boolean; result: string } | { approved: false }, where?: ActionHome): string {
  const head = `@approval:${id} ${summarizeAction(tool, args, undefined, where)}`;
  if (!outcome.approved) return `${head}: the owner denied this. It was not done.`;
  // On one line: a result's own lines could otherwise pass for another decision.
  const result = outcome.result.replace(/\s*\n\s*/g, " ");
  return `${head}: the owner approved it, and it ${outcome.isError ? "ran and failed" : "ran"}. Result: ${result}`;
}

export interface DecisionResult {
  ok: boolean;
  message: string;
  isError?: boolean;
  reply?: string;
  /** Asked to remember: whether a rule was kept. */
  remembered?: boolean;
  /**
   * False when the decision stood but the chat that asked could not carry
   * on from it (a model with no key, say), with why: said apart from the
   * decision, so a surface does not read a failure as plain success.
   */
  resumed?: false;
  resumeError?: string;
}

export interface DecisionsDeps {
  ownerId: string;
  approvals: {
    get: (id: number) => PendingAction | undefined;
    isAwaited: (id: number) => boolean;
    approve: (id: number, by: string, how: DecidedHow) => unknown;
    deny: (id: number, by: string, how: DecidedHow) => PendingAction | undefined;
    lapse: (id: number, via: LapseVia) => PendingAction | undefined;
    /** Everything still waiting, so a decision can see its siblings. */
    pending: () => PendingAction[];
  };
  permissions: {
    add: (rule: { tool: string; scope: string | null; project: string | null }) => unknown;
  };
  /** Where the asking chat's file paths land, for the line that tells it the outcome. */
  homeOf?: (conversationId: string | null) => Pick<PermissionContext, "home" | "root">;
  audit: { record: (entry: { tool: string; args: Record<string, unknown>; result: string; isError: boolean; riskTier: "risky"; userId: string; decidedVia: DecidedVia; approvalId: number; conversationId?: string }) => unknown };
  registry: {
    execute: (tool: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
    secretSlots: (tool: string) => SecretSlots | undefined;
    /** A yes-and-remember the tool keeps itself (a secret's grant on a site); see ToolRisk.keep. */
    keeps?: (tool: string, input: Record<string, unknown>) => boolean;
    /** Why the tool refuses this call now, judged inside the asking turn's stores; see ToolRisk.refuse. */
    refusal?: (tool: string, input: Record<string, unknown>) => Promise<string | undefined>;
    /** What the audit keeps of a call that ran; see ToolRisk.audited. All of it when absent. */
    audited?: (tool: string, input: Record<string, unknown>, result: { content: string; isError: boolean }) => { args: Record<string, unknown>; result: string };
    /** What the tool's ask becomes once no turn waits on it; see ToolRisk.detached. */
    detached?: (tool: string) => ToolRisk["detached"];
  };
  /** The kill switch: while thrown, no decision runs anything. */
  halted?: () => boolean;
  secrets: SecretsRegistry;
  queue: { enqueue: <T>(work: () => Promise<T>, lane: string) => Promise<T> };
  /** Run work with a conversation as the current one, so tools attribute to it. */
  inConversation: <T>(conversationId: string | null, work: () => Promise<T>) => Promise<T>;
  /** Something a tool did that the kernel must notice, e.g. a schedule changed. */
  onToolRan: (tool: string) => void;
  handleMessage: (text: string, opts: { sessionId: string; userId: string; origin: "system" }) => Promise<{ reply: string }>;
  /**
   * Why a yes on an ask that places a secret may be KOS's own hand, if it
   * may: decided on the device KOS is working on in that chat, or a moment
   * after a device acted for KOS. Read at each such yes; none, and none is.
   */
  handsOn?: (device: string | undefined, conversationId: string | null) => string | undefined;
  /** Where a yes hands the one-time code the owner typed on the card (secrets/codes.ts). */
  codes?: { offer: (approval: number, typed: string) => string | undefined };
}

/**
 * The surfaces a secret's use may be approved from: the dashboard and the
 * paired devices' own windows, and the CLI on the owner's machine. A typed
 * /approve on Discord, SMS or iMessage is refused, as is any surface not
 * listed.
 */
export const DECIDING_SURFACES: ReadonlySet<string> = new Set(["dashboard", "chrome", "mac", "phone", "cli"]);

/**
 * The surfaces that may lift the kill switch, run a job now, or put a chat
 * in Auto (throwing the kill switch is the safe direction, open to all): those a secret's ask is decided on, and Discord,
 * where the sender is the owner's account as Discord proves it. A text
 * message (SMS, iMessage) is the easiest to pass off as the owner's, so
 * neither is listed, and nor is any surface added later until it is.
 */
export const CONTROL_SURFACES: ReadonlySet<string> = new Set([...DECIDING_SURFACES, "discord"]);

/** Said on a surface outside CONTROL_SURFACES for a command only those may run. */
export function controlElsewhere(what: string): string {
  return `${what} is never done from a text message: one is the easiest to pass off as yours. Do it on the dashboard, a paired device or Discord.`;
}

/**
 * Where a decision is taken. Required on every approval, so a caller that
 * forgets to say is a type error, not a pass; any surface outside
 * DECIDING_SURFACES (a chat channel, one added later) is refused a secret's ask.
 */
export type DecisionSurface = "dashboard" | "chrome" | "mac" | "phone" | "cli" | "discord" | "sms" | "imessage" | (string & Record<never, never>);

/** Where a decision was taken: the surface, the paired device (its id) when one pressed it, and whether it was typed. */
export interface DecisionPlace {
  surface: DecisionSurface;
  device?: string;
  /** A typed /approve or /deny rather than a card's button: never enough to approve a secret's ask. */
  typed?: boolean;
}

/** A decision's place as the ask and the audit keep it. */
export function decidedHow(place: DecisionPlace): DecidedHow {
  return { via: place.typed ? typedVia(place.surface) : place.surface, ...(place.device ? { device: place.device } : {}) };
}

/** How a yes was given: where, and whether to remember it. */
export interface DecisionOptions extends DecisionPlace {
  remember?: boolean;
  /** The one-time code the owner typed into the card of an ask for one. Held in memory, never stored or logged. */
  code?: string;
}

/** Said on a chat surface for an ask that places a secret, or shows the owner's private data, in place of its buttons or a typed decision. */
export function secretAskElsewhere(id: number | string, tool?: string): string {
  if (tool !== undefined && PRIVATE_TOOLS.includes(tool)) {
    return `KOS asks: ${toolWords(tool)} (#${id}). Decide on the dashboard or a paired device; what it shows is private, so it is never shown or decided here.`;
  }
  return `KOS asks to use a secret (#${id}). Decide on the dashboard or a paired device; a secret's use is never decided here.`;
}

export class Decisions {
  constructor(private readonly deps: DecisionsDeps) {}

  /*
   * Outcomes of orphaned actions whose conversation still has others
   * waiting. Each decision used to resume the chat on its own, so two
   * approvals in a row were two whole turns, each told to "continue" and
   * each answering, with the second not knowing about the first. Now the
   * outcomes are held and the chat resumes once, when the last is decided,
   * told everything that was decided.
   */
  private readonly held = new Map<string, string[]>();

  /** The other pending actions of the same conversation, by id. */
  private siblingsWaiting(conversationId: string | null, id: number): number[] {
    return this.deps.approvals
      .pending()
      .filter((a) => a.conversationId === conversationId && a.id !== id)
      .map((a) => a.id);
  }

  /** The resume, with every outcome held for this conversation and this one. */
  private resumeText(sessionId: string, outcome: string): string {
    const lines = [...(this.held.get(sessionId) ?? []), outcome];
    this.held.delete(sessionId);
    return [
      `${RESUME_HEAD} ${lines.length === 1 ? "the pending action" : "the pending actions"}:`,
      ...lines.map((l) => `- ${l}`),
      "Carry on with the owner's request now, with these results.",
      "For a denied action, tell the owner in one line that you did not do it. Do not retry it or ask again unless they say so.",
      "Do not re-create resources that already exist (use slugs/ids from the results).",
      "If this was tasks.create_list, use tasks.add / tasks.list with the returned slug as instance.",
      "Reply in one or two lines: what was done and the result. Do not restate the request, the approval, or what you were about to do.",
    ].join("\n");
  }

  /** Where the asking chat's paths land, for the line that tells it the outcome. */
  private whereOf(conversationId: string | null | undefined): ActionHome | undefined {
    const at = this.deps.homeOf?.(conversationId ?? null);
    return at?.home ? { home: at.home, ...(at.root ? { root: at.root } : {}) } : undefined;
  }

  private stillWaiting(ids: number[]): string {
    return `#${ids.join(", #")} still waiting; the chat continues once ${ids.length === 1 ? "it is" : "they are"} decided.`;
  }

  async approve(id: number, decidedBy: string | undefined, options: DecisionOptions): Promise<DecisionResult> {
    const d = this.deps;
    const action = d.approvals.get(id);
    if (!action || action.status !== "pending") return { ok: false, message: `no pending action #${id}` };
    // Nothing runs while the kill switch is thrown, whoever waits on it: the ask stays for after.
    if (d.halted?.()) return { ok: false, message: `The kill switch is thrown, so nothing runs: #${id} waits until it is lifted.` };
    const stored = JSON.parse(action.args) as Record<string, unknown>;
    const placing = usesSecret(action.tool, stored);
    // A call that places a secret is approved only where the owner is proved: the dashboard or a paired device, never a chat surface.
    if (!DECIDING_SURFACES.has(options.surface) && placing) {
      return { ok: false, message: secretAskElsewhere(id, action.tool) };
    }
    // Typed words are not a press: on a device's own chat they could be KOS's own keys.
    if (options.typed && placing) {
      return { ok: false, message: `#${id} ${PRIVATE_TOOLS.includes(action.tool) ? "shows something private of yours" : "uses a secret"}, which is decided with its card's buttons on the dashboard or a paired device, never a typed /approve.` };
    }
    // Nor from where KOS's own pointer may be: the ask stays, for the owner to decide where KOS is not.
    const handsOn = placing ? d.handsOn?.(options.device, action.conversationId) : undefined;
    if (handsOn) return { ok: false, message: `#${id} was not approved: ${handsOn}` };
    const awaited = d.approvals.isAwaited(id);
    // An ask whose turn has gone runs only where its fate says so; the rest lapse, never running for nobody.
    if (!awaited && orphanFate(action, d.registry.detached?.(action.tool)) === "lapses") {
      d.approvals.lapse(id, "turn-gone");
      return { ok: false, message: `#${id} lapsed: KOS was no longer waiting on it, so nothing was done. Ask KOS again.` };
    }
    // An ask for a one-time code is a yes only with the code: the ask stays until one comes with it.
    if (action.secret?.code) {
      const refused = d.codes ? (options.code === undefined ? "Type the code into the card first." : d.codes.offer(id, options.code)) : "One-time codes are not taken here.";
      if (refused) return { ok: false, message: `#${id} was not approved: ${refused}` };
    }
    const how = decidedHow(options);
    d.approvals.approve(id, decidedBy ?? d.ownerId, how);

    // Kept, when the owner said so: the rule the ask named when it was
    // queued, and only that, since it is the one every card offered. None
    // for an ask that named none, none for a call that reached past its
    // turn's folder, and never for a call that sends a secret: each of
    // those is asked about. A secrets tool keeps its own yes (a grant on
    // the site), where the secret's policy offered one.
    const kept = options.remember === true && (placing ? d.registry.keeps?.(action.tool, stored) === true : action.rule !== null && !action.reached);
    if (kept && !placing) d.permissions.add(action.rule!);
    // Asked to remember one that keeps nothing: said so, rather than taken as kept.
    const done = (r: DecisionResult): DecisionResult =>
      !options.remember ? r : kept ? { ...r, remembered: true } : { ...r, remembered: false, message: `Approved; nothing to remember for this one. ${r.message}` };

    // A turn suspended on this decision does the rest itself.
    if (awaited) return done({ ok: true, message: `Approved @approval:${id}. ${toolWords(action.tool)}: running now.` });

    const by = decidedBy ?? d.ownerId;
    if (action.tool.startsWith(BUILD_ACTION_PREFIX)) {
      const wanted = action.tool.slice(BUILD_ACTION_PREFIX.length);
      d.audit.record({ tool: action.tool, args: stored, result: `approved; the build runs ${wanted} itself`, isError: false, riskTier: "risky", userId: by, decidedVia: how.via, approvalId: id, ...(action.conversationId ? { conversationId: action.conversationId } : {}) });
      return done({ ok: true, message: `Approved. The build continues with ${wanted}.` });
    }

    const result = await d.queue.enqueue(async () => {
      // Secrets only in the slots the tool declared, as GuardedTools places them.
      const placed = placeSecrets(action.tool, stored, d.registry.secretSlots(action.tool), d.secrets, { conversationId: action.conversationId, attended: action.attended, guest: action.guest !== null && action.guest !== undefined });
      // Run as the turn that asked would have: in its chat, as the caller; the owner's reach only if it was the owner's own turn, a guest's room's if a guest's.
      const asAsked = <T>(work: () => Promise<T>): Promise<T> =>
        guested.run(action.guest ?? undefined, () =>
          attendance.run(action.attended, () =>
            ownership.run(action.owner && action.attended, () =>
              d.inConversation(action.conversationId, () => (action.conversationId ? caller.run(action.conversationId, work) : work())),
            ),
          ),
        );
      const ran = "refused" in placed
        ? { content: placed.refused, isError: true }
        : await asAsked(async () => {
            // Judged again now, as the guarded path judges a call: what the tool refuses is not run on an old yes.
            const refused = await d.registry.refusal?.(action.tool, stored);
            if (refused) return { content: refused, isError: true };
            return approvedAs.run({ id, by }, () => d.registry.execute(action.tool, placed.input));
          });
      // What it answered is scrubbed before the audit and the resumed turn read it.
      const r = { ...ran, content: d.secrets.scrub(ran.content) };
      const kept = d.registry.audited?.(action.tool, stored, r) ?? { args: stored, result: r.content };
      d.audit.record({ tool: action.tool, args: kept.args, result: kept.result, isError: r.isError, riskTier: "risky", userId: by, decidedVia: how.via, approvalId: id, ...(action.conversationId ? { conversationId: action.conversationId } : {}) });
      if (!r.isError) d.onToolRan(action.tool);
      return r;
    }, action.conversationId ?? SHARED_LANE);

    const sessionId = action.conversationId ?? primarySessionId(d.ownerId);
    const outcome = decidedLine(id, action.tool, action.args, { approved: true, isError: result.isError, result: result.content }, this.whereOf(action.conversationId));
    const waiting = this.siblingsWaiting(action.conversationId, id);
    if (waiting.length > 0) {
      this.held.set(sessionId, [...(this.held.get(sessionId) ?? []), outcome]);
      return done({ ok: true, message: `${result.content} ${this.stillWaiting(waiting)}`, isError: result.isError });
    }
    let reply: string | undefined;
    let stuck: string | undefined;
    try {
      reply = (await d.handleMessage(this.resumeText(sessionId, outcome), { sessionId, userId: by, origin: "system" })).reply;
    } catch (err) {
      stuck = err instanceof Error ? err.message : String(err);
      reply = `Approved @approval:${id} but resume failed: ${stuck}`;
    }
    return done({ ok: true, message: result.content, isError: result.isError, ...(reply !== undefined ? { reply } : {}), ...(stuck !== undefined ? { resumed: false as const, resumeError: stuck } : {}) });
  }

  async deny(id: number, decidedBy: string | undefined, place: DecisionPlace): Promise<DecisionResult> {
    const d = this.deps;
    const awaited = d.approvals.isAwaited(id);
    const denied = d.approvals.deny(id, decidedBy ?? d.ownerId, decidedHow(place));
    if (!denied) return { ok: false, message: `no pending action #${id}` };
    if (awaited) return { ok: true, message: `Declined #${id}.` };
    if (denied.tool.startsWith(BUILD_ACTION_PREFIX)) {
      return { ok: true, message: `Declined. The build was told it may not ${denied.tool.slice(BUILD_ACTION_PREFIX.length)}.` };
    }
    const sessionId = denied.conversationId ?? primarySessionId(d.ownerId);
    const outcome = decidedLine(id, denied.tool, denied.args, { approved: false }, this.whereOf(denied.conversationId));
    const waiting = this.siblingsWaiting(denied.conversationId, id);
    if (waiting.length > 0) {
      this.held.set(sessionId, [...(this.held.get(sessionId) ?? []), outcome]);
      return { ok: true, message: `Denied @approval:${id}. ${this.stillWaiting(waiting)}` };
    }
    let reply: string | undefined;
    let stuck: string | undefined;
    try {
      reply = (await d.handleMessage(this.resumeText(sessionId, outcome), { sessionId, userId: decidedBy ?? d.ownerId, origin: "system" })).reply;
    } catch (err) {
      stuck = err instanceof Error ? err.message : String(err);
      reply = `Denied @approval:${id}.`;
    }
    return { ok: true, message: `denied @approval:${id}`, ...(reply !== undefined ? { reply } : {}), ...(stuck !== undefined ? { resumed: false as const, resumeError: stuck } : {}) };
  }
}
