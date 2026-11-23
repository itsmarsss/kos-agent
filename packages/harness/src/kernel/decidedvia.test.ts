import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DETACHED_WORDS } from "@kos/shared";

import type { Inference } from "../agent/loop.js";
import { ApprovalQueue, type EnqueueInput, type PendingAction } from "../ops/approvals.js";
import { AuditLog } from "../ops/audit.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { parseChatCommand } from "./chatcommands.js";
import { Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";

/**
 * Every path that settles an ask says where it came from, and an ask whose
 * waiting turn has gone lapses rather than running later for nobody,
 * unless its tool's effect is the point on its own.
 */

const usage = { inputTokens: 0, outputTokens: 0 };

/** A model that asks to run one risky call, so a turn waits on the owner. */
const asksOnce: Inference = {
  async generate(_task, req) {
    if (JSON.stringify(req.messages.at(-1)).includes("tool_result")) return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage, model: "stub" };
    return { content: [{ type: "tool_use", id: "t1", name: "danger.run", input: { what: "clear the cache" } }], stopReason: "tool_use", usage, model: "stub" };
  },
};

/** The Maintenance delete a restart left pending on the owner's host (#742), as a turn queued it. */
const ORPHAN_DELETE: EnqueueInput = {
  tool: "sql",
  args: { sql: "DELETE FROM conversations WHERE id IN ('cron:22','cron:23')" },
  riskTier: "risky",
  reason: "deletes rows",
  owner: true,
  attended: true,
  waits: true,
};

describe("where each decision came from, and asks whose turn is gone", () => {
  let root: string;
  let kernel: Kernel;
  let ran: string[];
  /** The chat the orphaned asks came from. */
  let maintenance: string;
  const orphanOf = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({ ...ORPHAN_DELETE, conversationId: maintenance, ...over });

  const boot = async (): Promise<Kernel> => {
    const k = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: asksOnce, chrome: { port: 1, exists: () => false } });
    k.registry.register({ name: "danger.run", description: "d", inputSchema: { type: "object" } }, () => (ran.push("danger.run"), "cleared"), { floor: "risky" });
    k.registry.register({ name: "notice.post", description: "d", inputSchema: { type: "object" } }, () => (ran.push("notice.post"), "posted"), { floor: "risky", detached: "runs" });
    return k;
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-via-"));
    ran = [];
    kernel = await boot();
    maintenance = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Maintenance" }).id;
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const owner = (): string => kernel.profile.ownerId;
  /** A turn that asks, left waiting on the owner: its chat and its ask. */
  const asking = async (): Promise<{ chat: string; ask: PendingAction }> => {
    const chat = kernel.conversations.create({ userId: owner(), title: "Chores" }).id;
    void kernel.handleMessage("clear it", { sessionId: chat, userId: owner(), owner: true });
    const ask = await vi.waitFor(() => {
      const found = kernel.approvals.pending().find((a) => a.conversationId === chat && kernel.approvals.isAwaited(a.id));
      expect(found).toBeDefined();
      return found!;
    });
    return { chat, ask };
  };
  /** The turn that waited has carried on and ended: a suspended turn's message returns while it waits. */
  const ended = (chat: string): Promise<void> => vi.waitFor(() => expect(kernel.busyConversations()).not.toContain(chat));
  const audited = (tool: string) => kernel.audit.recent(50).find((r) => r.tool === tool);

  it("keeps the surface and device of a press, on the ask and on the audit of the call it ran", async () => {
    const { chat, ask } = await asking();
    await kernel.approve(ask.id, undefined, { surface: "mac", device: "dev-7" });
    await ended(chat);
    expect(kernel.approvals.get(ask.id)).toMatchObject({ status: "approved", decidedVia: "mac", decidedDevice: "dev-7" });
    expect(audited("danger.run")).toMatchObject({ decidedVia: "mac", approvalId: ask.id, isError: false });
  });

  it("keeps the dashboard's yes and no as the dashboard's", async () => {
    const first = await asking();
    await handleApiRequest(kernel, { method: "POST", path: "/api/deny", body: { id: first.ask.id } });
    await ended(first.chat);
    expect(kernel.approvals.get(first.ask.id)).toMatchObject({ status: "denied", decidedVia: "dashboard", decidedDevice: null });
  });

  it("tells a typed /approve and /deny from a press", async () => {
    const run = (text: string, chat: string) => kernel.runKernelCommand(parseChatCommand(text)!, chat, owner(), "discord", true);
    const yes = await asking();
    await run("/approve", yes.chat);
    await ended(yes.chat);
    expect(kernel.approvals.get(yes.ask.id)?.decidedVia).toBe("typed:discord");
    const no = await asking();
    await run("/deny", no.chat);
    await ended(no.chat);
    expect(kernel.approvals.get(no.ask.id)).toMatchObject({ status: "denied", decidedVia: "typed:discord" });
  });

  it("audits a call a remembered rule let run as the rule's", async () => {
    kernel.permissions.add({ tool: "danger.run", scope: null, project: null });
    const chat = kernel.conversations.create({ userId: owner(), title: "Ruled" }).id;
    await kernel.handleMessage("clear it", { sessionId: chat, userId: owner(), owner: true });
    expect(kernel.approvals.pending()).toEqual([]);
    expect(audited("danger.run")).toMatchObject({ decidedVia: "rule", approvalId: null });
  });

  it("says a Stop and the kill switch apart on the asks they lapse", async () => {
    const stopped = await asking();
    kernel.stop(stopped.chat);
    await ended(stopped.chat);
    expect(kernel.approvals.get(stopped.ask.id)).toMatchObject({ status: "expired", decidedVia: "stopped" });
    const halted = await asking();
    kernel.killSwitch.halt();
    await ended(halted.chat);
    expect(kernel.approvals.get(halted.ask.id)).toMatchObject({ status: "expired", decidedVia: "kill-switch" });
    kernel.killSwitch.resume();
  });

  it("lapses a deleted chat's asks as the deletion's", () => {
    const chat = kernel.conversations.create({ userId: owner(), title: "Gone" }).id;
    const ask = kernel.approvals.enqueue({ tool: "danger.run", args: {}, riskTier: "risky", conversationId: chat });
    kernel.conversations.remove(chat);
    expect(kernel.approvals.get(ask.id)).toMatchObject({ status: "expired", decidedVia: "chat-deleted" });
  });

  it("lapses asks nobody answered in their hours as the clock's", () => {
    const ask = kernel.approvals.enqueue({ tool: "danger.run", args: {}, riskTier: "risky" });
    kernel.workspace.db.prepare(`UPDATE pending_actions SET requested_at = 0 WHERE id = ?`).run(ask.id);
    expect(kernel.sweepExpiredApprovals().map((a) => a.id)).toEqual([ask.id]);
    expect(kernel.approvals.get(ask.id)?.decidedVia).toBe("timeout");
  });

  it("lapses an orphaned delete at boot, tells its chat, and runs nothing", async () => {
    const orphan = kernel.approvals.enqueue(orphanOf());
    // A schedule's ask was raised to be decided later: no turn ever waited on it.
    const later = kernel.approvals.enqueue(orphanOf({ waits: false }));
    // The host stops under the turn that held for it.
    kernel.close();
    kernel = await boot();
    expect(kernel.approvals.get(orphan.id)?.status).toBe("pending");
    kernel.markInterrupted();
    expect(kernel.approvals.get(orphan.id)).toMatchObject({ status: "expired", decidedVia: "restart" });
    expect(kernel.approvals.get(later.id)).toMatchObject({ status: "pending", detachedAt: null });
    const said = JSON.stringify(kernel.sessions.get(maintenance));
    expect(said).toContain(`@approval:${orphan.id}`);
    expect(said).toContain("lapsed: the chat stopped before you decided");
    expect((await kernel.approve(orphan.id, undefined, { surface: "dashboard" })).ok).toBe(false);
  });

  it("keeps an orphan whose effect is the point, warns on its card, and runs it when approved", async () => {
    const orphan = kernel.approvals.enqueue(orphanOf({ tool: "notice.post", args: { text: "back soon" } }));
    kernel.markInterrupted();
    expect(kernel.approvals.get(orphan.id)).toMatchObject({ status: "pending", detachedAt: expect.any(Number) });
    const cards = (await handleApiRequest(kernel, { method: "GET", path: "/api/approvals" })).body as { id: number; detached?: string }[];
    expect(cards.find((c) => c.id === orphan.id)?.detached).toBe(DETACHED_WORDS.stopped);
    await kernel.approve(orphan.id, undefined, { surface: "phone" });
    expect(ran).toEqual(["notice.post"]);
    expect(audited("notice.post")).toMatchObject({ decidedVia: "phone", approvalId: orphan.id });
  });

  it("warns on the card of an ask nothing ever waited on, and not on one a turn holds for", async () => {
    const later = kernel.approvals.enqueue(orphanOf({ waits: false }));
    const held = await asking();
    const cards = (await handleApiRequest(kernel, { method: "GET", path: "/api/approvals" })).body as { id: number; detached?: string }[];
    expect(cards.find((c) => c.id === later.id)?.detached).toBe(DETACHED_WORDS.unwaited);
    expect(cards.find((c) => c.id === held.ask.id)?.detached).toBeUndefined();
    await kernel.deny(held.ask.id, undefined, { surface: "dashboard" });
    await ended(held.chat);
  });

  it("lapses an ask approved after its turn has gone, without a sweep, and runs nothing", async () => {
    const orphan = kernel.approvals.enqueue(orphanOf({ tool: "danger.run", args: {} }));
    const res = await kernel.approve(orphan.id, undefined, { surface: "discord" });
    expect(res).toMatchObject({ ok: false });
    expect(res.message).toMatch(/lapsed: KOS was no longer waiting on it/);
    expect(kernel.approvals.get(orphan.id)).toMatchObject({ status: "expired", decidedVia: "turn-gone" });
    expect(ran).toEqual([]);
  });

  it("settles what this process's turns waited on when it closes: lapsed, or kept to run detached", async () => {
    const { ask } = await asking();
    const kept = kernel.approvals.enqueue(orphanOf({ tool: "notice.post", args: {} }));
    // As if a turn of this process held for it too.
    void kernel.approvals.waitFor(kept.id, 60_000);
    // Another process's ask (the host's, under a CLI that opened the workspace): not this close's to settle.
    const elsewhere = kernel.approvals.enqueue(orphanOf({ tool: "danger.run", args: {} }));
    kernel.close();
    const ws = Workspace.open(root);
    try {
      const after = new ApprovalQueue(ws.db);
      expect(after.get(ask.id)).toMatchObject({ status: "expired", decidedVia: "shutdown" });
      expect(after.get(kept.id)).toMatchObject({ status: "pending", detachedAt: expect.any(Number) });
      expect(after.get(elsewhere.id)).toMatchObject({ status: "pending", detachedAt: null });
      expect(new AuditLog(ws.db).recent(5).some((r) => r.tool === "danger.run")).toBe(false);
    } finally {
      ws.close();
    }
    kernel = await boot();
  });
});
