import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { CronJob } from "../cron/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { BLOB_TOOLS } from "../tools/agents.js";
import { guested } from "./caller.js";
import { projectScope } from "../memory/facts.js";
import { MAINTENANCE } from "./caretaker.js";
import type { GuardedTools } from "./guarded.js";
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
  /** Every model request, as text. */
  let asked: string[];
  const maintenance = `project:${MAINTENANCE.slug}`;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-guest-reach-"));
    asked = [];
    const inference: Inference = {
      async generate(_task, req) {
        asked.push(JSON.stringify(req));
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

  /** Work a guest's turn in the daily room passes on, past the handoff's own fence: the marker alone holds it. */
  const room = { project: "daily", chat: "project:daily" };
  const passOn = (to: string, text: string): Promise<unknown> => {
    if (to.startsWith("project:")) kernel.ensureProjectConversation(to.slice("project:".length));
    return guested.run(room, () => kernel.dispatchTo(to, text, "project:daily"));
  };

  it("hands a guest's ask on only within their room", async () => {
    const rootChat = kernel.ensureOrchestratorConversation().id;
    const other = kernel.standUpProject({ name: "Other", type: "tracker" });
    kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    const loose = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Loose" });
    let n = 0;
    for (const to of [`chat:${rootChat}`, maintenance, other.conversationId, "blob:noter", `chat:${loose.id}`]) {
      await kernel.handleProjectTurn("daily", `HAND-TO:${to}`, { channel: "discord", guest });
      const refused = await lastSql("project:daily", ++n);
      expect(refused.isError, to).toBe(true);
      expect(refused.content).toMatch(/outside the room a guest's words came from/);
    }
    for (const id of [rootChat, maintenance, other.conversationId, "agent:noter", loose.id]) expect(tools.has(id), id).toBe(false);

    // A chat of the room's own project takes it, and answers with the guest tools alone.
    const members = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Members", projectSlug: "daily" });
    await kernel.handleProjectTurn("daily", `HAND-TO:chat:${members.id} READ-OWN`, { channel: "discord", guest });
    expect((await lastSql("project:daily", ++n)).isError).not.toBe(true);
    const own = await lastSql(members.id, 1);
    expect(own.isError).not.toBe(true);
    asGuest(members.id);
  });

  it("refuses a guest's work passed to Maintenance or another project what they reach", async () => {
    await passOn(maintenance, "READ-SESSIONS");
    const handed = await lastSql(maintenance, 1);
    expect(handed.isError).toBe(true);
    expect(handed.content).toMatch(/a guest's words started this work/);

    // The other project's orchestrator holds sql by its grant; a guest's work does not borrow it.
    const other = kernel.standUpProject({ name: "Other", type: "tracker" });
    await passOn(other.conversationId, "READ-OWN");
    const elsewhere = await lastSql(other.conversationId, 1);
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.content).toMatch(/a guest's words started this work/);
  });

  it("remembers on a guest's turn only what is their room's project's", async () => {
    kernel.facts.upsert(kernel.profile.ownerId, { key: "vault_code", value: "the vault code is 4242", kind: "fact", pinned: true });
    kernel.facts.upsert(kernel.profile.ownerId, { key: "problem_secret", value: "the owner's problem secret is hidden", kind: "fact" });
    kernel.facts.upsert(kernel.profile.ownerId, { key: "daily_rule", value: "one problem a day", kind: "fact", pinned: true, scope: projectScope("daily") });
    const said = (): string => asked.at(-1)!;

    await kernel.handleProjectTurn("daily", "what is the problem secret", { channel: "discord", guest });
    expect(said()).toContain("one problem a day");
    expect(said()).not.toContain("4242");
    expect(said()).not.toContain("problem secret is hidden");
    expect(said()).toContain("tell them what was asked with notify (to: owner)");
    expect(said()).not.toContain("owner's orchestrator");

    // Handed on, the same: the target's own scope does not widen it.
    await passOn(maintenance, "what is the problem secret");
    await vi.waitFor(() => expect(kernel.busyConversations()).not.toContain(maintenance));
    expect(said()).not.toContain("4242");
    expect(said()).not.toContain("problem secret is hidden");

    // The owner in the same room is told everything that is theirs.
    await kernel.handleProjectTurn("daily", "what is the problem secret", { channel: "discord", owner: true });
    expect(said()).toContain("4242");
    expect(said()).toContain("problem secret is hidden");
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

  it("gives a guest's work passed to the root or a blob only the guest tools", async () => {
    const mine = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Private" });
    kernel.sessions.set(mine.id, [{ role: "user", content: [{ type: "text", text: "my secret" }] }]);
    const rootChat = kernel.ensureOrchestratorConversation().id;
    expect(rootChat).toBe(orchestratorId(kernel.profile.ownerId));

    await passOn(rootChat, `READ-CHAT:${mine.id}`);
    const read = await lastSql(rootChat, 1);
    asGuest(rootChat);
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain("my secret");

    await passOn(rootChat, "RECALL");
    const recalled = await lastSql(rootChat, 2);
    asGuest(rootChat);
    expect(recalled.isError).toBe(true);
    expect(recalled.content).toMatch(/not available/);

    kernel.roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    await passOn(kernel.ensureAgentConversation("noter").id, `READ-CHAT:${mine.id}`);
    const blob = await lastSql("agent:noter", 1);
    asGuest("agent:noter");
    expect(blob.isError).toBe(true);
    expect(blob.content).not.toContain("my secret");
  });

  it("refuses a guest's work a blob or a schedule, whatever tools it was given", async () => {
    const rootChat = kernel.ensureOrchestratorConversation().id;
    const toolbox = (kernel as unknown as { guardedTools: (o: object) => GuardedTools }).guardedTools({
      conversationId: rootChat,
      guest: { project: "daily", chat: "project:daily" },
      grant: [...BLOB_TOOLS],
    });
    const made = await toolbox.execute("blobs.create", { name: "spy", description: "d", brief: "b", schedule: "0 * * * *", prompt: "go" });
    expect(made.isError).toBe(true);
    expect(made.content).toMatch(/owner's to set up, and a guest's words started this work/);
    const job = await toolbox.execute("cron.schedule", { name: "spy", schedule: "0 * * * *", type: "self_prompt", prompt: "go" });
    expect(job.isError).toBe(true);
    expect(job.content).toMatch(/owner's to set up/);
    expect(kernel.roles.exists("spy")).toBe(false);
    expect(kernel.crons.list().some((c) => c.name === "spy")).toBe(false);
    // The owner's own turn still makes one.
    const own = (kernel as unknown as { guardedTools: (o: object) => GuardedTools }).guardedTools({ conversationId: rootChat, owner: true, grant: [...BLOB_TOOLS] });
    expect((await own.execute("blobs.create", { name: "helper", description: "d", brief: "b" })).isError).toBe(false);
    expect(guested.run(undefined, () => kernel.roles.exists("helper"))).toBe(true);
  });

  it("keeps a guest's passed-on work under their room when the owner retries it", async () => {
    await passOn(maintenance, "READ-SESSIONS");
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
