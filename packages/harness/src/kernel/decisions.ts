import type { PendingAction } from "../ops/approvals.js";
import { SHARED_LANE } from "../ops/queue.js";
import { injectSecrets } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
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

/** A build's permission requests are decided here and performed by the build itself. */
export const BUILD_ACTION_PREFIX = "build.";

export interface DecisionResult {
  ok: boolean;
  message: string;
  isError?: boolean;
  reply?: string;
}

export interface DecisionsDeps {
  ownerId: string;
  approvals: {
    get: (id: number) => PendingAction | undefined;
    isAwaited: (id: number) => boolean;
    approve: (id: number, by: string) => unknown;
    deny: (id: number, by: string) => PendingAction | undefined;
  };
  permissions: {
    ruleFor: (tool: string, input: Record<string, unknown>, project: string | null) => { tool: string; scope: string | null; project: string | null } | undefined;
    add: (rule: { tool: string; scope: string | null; project: string | null }) => unknown;
  };
  conversations: { get: (id: string) => { projectSlug: string | null } | undefined };
  audit: { record: (entry: { tool: string; args: Record<string, unknown>; result: string; isError: boolean; riskTier: "risky"; userId: string }) => unknown };
  registry: { execute: (tool: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }> };
  secrets: SecretsRegistry;
  queue: { enqueue: <T>(work: () => Promise<T>, lane: string) => Promise<T> };
  /** Run work with a conversation as the current one, so tools attribute to it. */
  inConversation: <T>(conversationId: string | null, work: () => Promise<T>) => Promise<T>;
  /** Something a tool did that the kernel must notice, e.g. a schedule changed. */
  onToolRan: (tool: string) => void;
  handleMessage: (text: string, opts: { sessionId: string; userId: string; origin: "system" }) => Promise<{ reply: string }>;
}

export class Decisions {
  constructor(private readonly deps: DecisionsDeps) {}

  async approve(id: number, decidedBy?: string, options: { remember?: boolean } = {}): Promise<DecisionResult> {
    const d = this.deps;
    const action = d.approvals.get(id);
    if (!action || action.status !== "pending") return { ok: false, message: `no pending action #${id}` };
    const awaited = d.approvals.isAwaited(id);
    d.approvals.approve(id, decidedBy ?? d.ownerId);

    // Kept, when the owner said so: the shape of this call, in the project
    // it came from. A call whose shape cannot be named makes no rule.
    if (options.remember) {
      const project = action.conversationId ? (d.conversations.get(action.conversationId)?.projectSlug ?? null) : null;
      const rule = d.permissions.ruleFor(action.tool, JSON.parse(action.args) as Record<string, unknown>, project);
      if (rule) d.permissions.add(rule);
    }

    // A turn suspended on this decision does the rest itself.
    if (awaited) return { ok: true, message: `Approved #${id}. ${action.tool} is running.` };

    const stored = JSON.parse(action.args) as Record<string, unknown>;
    const by = decidedBy ?? d.ownerId;
    if (action.tool.startsWith(BUILD_ACTION_PREFIX)) {
      const wanted = action.tool.slice(BUILD_ACTION_PREFIX.length);
      d.audit.record({ tool: action.tool, args: stored, result: `approved; the build runs ${wanted} itself`, isError: false, riskTier: "risky", userId: by });
      return { ok: true, message: `Approved. The build continues with ${wanted}.` };
    }

    const result = await d.queue.enqueue(async () => {
      const r = await d.inConversation(action.conversationId, () => d.registry.execute(action.tool, injectSecrets(stored, d.secrets)));
      d.audit.record({ tool: action.tool, args: stored, result: r.content, isError: r.isError, riskTier: "risky", userId: by });
      if (!r.isError) d.onToolRan(action.tool);
      return r;
    }, action.conversationId ?? SHARED_LANE);

    const sessionId = action.conversationId ?? primarySessionId(d.ownerId);
    const resumePrompt = [
      `System: the owner approved pending action #${id}.`,
      `tool=${action.tool}`,
      `outcome=${result.isError ? "FAILED" : "SUCCEEDED"}`,
      `result=${result.content}`,
      "Continue the owner's prior request now.",
      "Do not re-create resources that already exist (use slugs/ids from result).",
      "If this was tasks.create_list, use tasks.add / tasks.list with the returned slug as instance.",
      "Prefer short checklist-style replies.",
    ].join(" ");
    let reply: string | undefined;
    try {
      reply = (await d.handleMessage(resumePrompt, { sessionId, userId: by, origin: "system" })).reply;
    } catch (err) {
      reply = `Approved #${id} but resume failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { ok: true, message: result.content, isError: result.isError, ...(reply !== undefined ? { reply } : {}) };
  }

  async deny(id: number, decidedBy?: string): Promise<DecisionResult> {
    const d = this.deps;
    const awaited = d.approvals.isAwaited(id);
    const denied = d.approvals.deny(id, decidedBy ?? d.ownerId);
    if (!denied) return { ok: false, message: `no pending action #${id}` };
    if (awaited) return { ok: true, message: `Declined #${id}.` };
    if (denied.tool.startsWith(BUILD_ACTION_PREFIX)) {
      return { ok: true, message: `Declined. The build was told it may not ${denied.tool.slice(BUILD_ACTION_PREFIX.length)}.` };
    }
    const sessionId = denied.conversationId ?? primarySessionId(d.ownerId);
    let reply: string | undefined;
    try {
      reply = (await d.handleMessage(
        `System: the owner denied pending action #${id}. Acknowledge briefly and ask how to proceed without that action.`,
        { sessionId, userId: decidedBy ?? d.ownerId, origin: "system" },
      )).reply;
    } catch {
      reply = `Denied #${id}.`;
    }
    return { ok: true, message: `denied #${id}`, ...(reply !== undefined ? { reply } : {}) };
  }
}
