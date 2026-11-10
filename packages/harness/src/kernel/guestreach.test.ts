import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { CronJob } from "../cron/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { MAINTENANCE } from "./caretaker.js";
import { GUEST_TOOLS, Kernel, orchestratorId } from "./kernel.js";
import { handleApiRequest } from "./server.js";

type Result = { content: string; isError?: boolean };

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], stopReason: "end_turn" as const, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
const call = (name: string, input: Record<string, unknown>) => ({ content: [{ type: "tool_use" as const, id: "t1", name, input }], stopReason: "tool_use" as const, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

/**
 * Maintenance reaches KOS's own tables for the owner and for KOS itself. A
 * guest's words, said in its channel or handed on from another, reach none
 * of them, and no project's tables but those of the room they spoke in.
 * Each turn's model does what its newest message says, end to end.
 */
describe("what a guest's words reach, wherever they are handed", () => {
  let root: string;
  let kernel: Kernel;
  let tools: Map<string, { allow?: string[]; grant?: string[]; guest?: unknown }>;
  const maintenance = `project:${MAINTENANCE.slug}`;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-guest-reach-"));
    const inference: Inference = {
      async generate(_task, req) {
        const sent = JSON.stringify(req.messages.at(-1));
        if (sent.includes("tool_result")) return reply("ok");
        const hand = /HAND-TO:([\w:-]+)/.exec(sent)?.[1];
        const ask = /ASK:([\w:-]+)/.exec(sent)?.[1] ?? (sent.includes("READ-OWN") ? "READ-OWN" : "READ-SESSIONS");
        if (hand) return call("chats.handoff", { to: `@${hand}`, brief: "A member asked.", ask });
        const chat = /READ-CHAT:([\w:-]+)/.exec(sent)?.[1];
        if (chat) return call("chats.read", { id: chat });
        if (sent.includes("RECALL")) return call("memory.recall", { query: "anything" });
        if (sent.includes("READ-SESSIONS")) return call("sql", { sql: "SELECT id FROM chat_sessions" });
        if (sent.includes("READ-OWN")) return call("sql", { sql: "SELECT handle FROM daily_members" });
        return reply("ok");
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, chrome: { port: 1, exists: () => false } });
    // What each turn's toolbox was given, by conversation, last first.
    tools = new Map();
    const k = kernel as unknown as { guardedTools: (o: { conversationId?: string; allow?: string[]; grant?: string[] }) => unknown };
    const real = k.guardedTools.bind(kernel);
    vi.spyOn(k, "guardedTools").mockImplementation((o) => {
      if (o.conversationId) tools.set(o.conversationId, o);
      return real(o);
    });
    kernel.standUpProject({ name: "Daily", type: "tracker" });
    kernel.workspace.db.exec("CREATE TABLE daily_members (handle TEXT)");
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const guest = { id: "g1", name: "Sam" };
  /** The newest sql result in a chat, once its turn has ended. */
  const lastSql = async (id: string, count: number): Promise<Result> => {
    const results = (): Result[] => kernel.sessions.get(id).flatMap((m) => m.content.filter((b) => b.type === "tool_result")) as Result[];
    await vi.waitFor(() => expect(results()).toHaveLength(count));
    await vi.waitFor(() => expect(kernel.busyConversations()).not.toContain(id));
    return results().at(-1)!;
  };

  it("refuses a guest in Maintenance's own channel KOS's tables", async () => {
    await kernel.handleProjectTurn(MAINTENANCE.slug, "READ-SESSIONS", { channel: "discord", guest });
    const res = await lastSql(maintenance, 1);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/a guest's words started this work/);
  });

  it("refuses a guest's handoff to Maintenance, and to another project, what they reach", async () => {
    await kernel.handleProjectTurn("daily", `HAND-TO:${maintenance}`, { channel: "discord", guest });
    const handed = await lastSql(maintenance, 1);
    expect(handed.isError).toBe(true);
    expect(handed.content).toMatch(/a guest's words started this work/);

    // The other project's orchestrator holds sql by its grant; a guest's work does not borrow it.
    const other = kernel.standUpProject({ name: "Other", type: "tracker" });
    await kernel.handleProjectTurn("daily", `HAND-TO:${other.conversationId} READ-OWN`, { channel: "discord", guest });
    const elsewhere = await lastSql(other.conversationId, 1);
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.content).toMatch(/a guest's words started this work/);
  });

  it("keeps a guest's own room's tables theirs", async () => {
    await kernel.handleProjectTurn("daily", "READ-OWN", { channel: "discord", guest });
    const res = await lastSql("project:daily", 1);
    expect(res.isError).not.toBe(true);
    expect(res.content).toBe("[]");
  });

  it("lets the owner's handoff and a scheduled run read KOS's tables in Maintenance", async () => {
    const from = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Mine" });
    await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/handoff", body: { from: from.id, to: `@${maintenance}`, brief: "Look.", ask: "READ-SESSIONS" } });
    const handed = await lastSql(maintenance, 1);
    expect(handed.isError).not.toBe(true);
    expect(handed.content).toMatch(/^\[/);

    const job = kernel.crons.create({ name: "upkeep", schedule: "0 3 * * *", type: "self_prompt", prompt: "READ-SESSIONS", projectSlug: MAINTENANCE.slug, enabled: true });
    await (kernel as unknown as { runJobTurn: (p: string, j: CronJob) => Promise<string> }).runJobTurn("READ-SESSIONS", job);
    const thread = kernel.conversations.get(`cron:${job.id}`)!;
    expect(thread.projectSlug).toBe(MAINTENANCE.slug);
    const scheduled = await lastSql(thread.id, 1);
    expect(scheduled.isError).not.toBe(true);
    expect(scheduled.content).toMatch(/^\[/);
  });

  it("runs a guest's orphaned approval no further than their room", async () => {
    const asked = kernel.approvals.enqueue({ tool: "sql", args: { sql: "SELECT id FROM chat_sessions" }, riskTier: "risky", conversationId: maintenance, owner: false, attended: false, guest: { project: MAINTENANCE.slug, chat: maintenance } });
    expect(kernel.approvals.get(asked.id)?.guest).toEqual({ project: MAINTENANCE.slug, chat: maintenance });
    const res = await kernel.approve(asked.id);
    expect(res).toMatchObject({ ok: true, isError: true });
    expect(res.message).toMatch(/a guest's words started this work/);
  });

  /** A guest's work on this hop: no more than the guest tools, and no grant. */
  const asGuest = (id: string): void => {
    const given = tools.get(id);
    expect(given?.guest).toBeDefined();
    expect(given?.grant).toBeUndefined();
    for (const t of given?.allow ?? ["unrestricted"]) expect(GUEST_TOOLS, t).toContain(t);
  };

  it("gives a guest's handoff to the root or a blob only the guest tools", async () => {
    const mine = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Private" });
    kernel.sessions.set(mine.id, [{ role: "user", content: [{ type: "text", text: "my secret" }] }]);
    const rootChat = kernel.ensureOrchestratorConversation().id;
    expect(rootChat).toBe(orchestratorId(kernel.profile.ownerId));

    await kernel.handleProjectTurn("daily", `HAND-TO:chat:${rootChat} ASK:READ-CHAT:${mine.id}`, { channel: "discord", guest });
    const read = await lastSql(rootChat, 1);
    asGuest(rootChat);
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain("my secret");

    await kernel.handleProjectTurn("daily", `HAND-TO:chat:${rootChat} ASK:RECALL`, { channel: "discord", guest });
    const recalled = await lastSql(rootChat, 2);
    asGuest(rootChat);
    expect(recalled.isError).toBe(true);
    expect(recalled.content).toMatch(/not available/);

    kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    await kernel.handleProjectTurn("daily", `HAND-TO:blob:noter ASK:READ-CHAT:${mine.id}`, { channel: "discord", guest });
    const blob = await lastSql("agent:noter", 1);
    asGuest("agent:noter");
    expect(blob.isError).toBe(true);
    expect(blob.content).not.toContain("my secret");
  });

  it("keeps a guest's handoff under their room when the owner retries it", async () => {
    await kernel.handleProjectTurn("daily", `HAND-TO:${maintenance}`, { channel: "discord", guest });
    expect((await lastSql(maintenance, 1)).isError).toBe(true);
    const handed = kernel.sessions.get(maintenance).find((m) => m.role === "user" && m.origin?.guested);
    expect(handed?.origin?.guested).toEqual({ project: "daily", chat: "project:daily" });

    tools.delete(maintenance);
    await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/rewind", body: { sessionId: maintenance, index: 0 } });
    const retried = await lastSql(maintenance, 1);
    expect(tools.get(maintenance)?.guest).toEqual({ project: "daily", chat: "project:daily" });
    expect(retried.isError).toBe(true);
    expect(retried.content).toMatch(/a guest's words started this work/);
  });
});
