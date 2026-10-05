import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ConversationStore } from "../kernel/conversations.js";
import type { CongregationMember } from "../kernel/progress.js";
import { SessionStore } from "../kernel/session.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createChatsModule, MAX_CONGREGATION, type ChatToolDeps } from "./chats.js";

/**
 * chats.congregate, driven through the registry with a scripted dispatch.
 *
 * The kernel's dispatchTo is covered in flows.test.ts; what is load-bearing
 * here is the fan-out itself: every member asked at once, every reply back in
 * order, one failure reported rather than fatal, and the scope guard that
 * keeps one project out of another.
 */

const OWNER = "owner";
const DISPATCHER = "orchestrator:owner";

interface Harness {
  registry: ToolRegistry;
  conversations: ConversationStore;
  /** Every dispatch, in the order it was asked. */
  asked: Array<{ id: string; text: string }>;
  /** Every roster told to the dispatcher, in order. */
  rosters: Array<{ from: string; members: CongregationMember[] }>;
}

interface Members {
  question?: string;
  members: Array<{ id: string; title: string; ok: boolean; reply: string }>;
}

async function harness(
  ws: Workspace,
  options: {
    dispatch?: ChatToolDeps["dispatch"];
    scope?: string;
    timeoutMs?: number;
    hide?: string[];
    /** No conversation is dispatching, as from a bare registry call. */
    anonymous?: boolean;
  } = {},
): Promise<Harness> {
  const conversations = new ConversationStore(ws.db);
  const sessions = new SessionStore(ws.db);
  const registry = new ToolRegistry();
  const asked: Harness["asked"] = [];
  const rosters: Harness["rosters"] = [];
  const dispatch: ChatToolDeps["dispatch"] =
    options.dispatch ??
    (async (id, text) => ({ reply: `${id} says: ${text}`, conversationId: id }));
  const timeoutMs = options.timeoutMs;
  const ctx = toolRegistryContext(registry, {
    workspace: ws,
    db: ws.db,
    secrets: new SecretsRegistry(),
  });
  await new ModuleLoader(ctx).load([
    createChatsModule({
      conversations,
      sessions,
      ownerId: OWNER,
      dispatch: (id, text) => {
        asked.push({ id, text });
        return dispatch(id, text);
      },
      currentConversationId: () => (options.anonymous ? undefined : DISPATCHER),
      scope: () => options.scope,
      onCongregation: (from, members) => rosters.push({ from, members }),
      ...(timeoutMs !== undefined ? { congregationTimeoutMs: () => timeoutMs } : {}),
      ...(options.hide ? { hide: options.hide } : {}),
    }),
  ]);
  return { registry, conversations, asked, rosters };
}

describe("chats.congregate", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-congregate-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("asks every member at once and returns every reply in order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const h = await harness(ws, {
      dispatch: async (id, text) => {
        started += 1;
        await gate;
        return { reply: `${id}: ${text}`, conversationId: id };
      },
    });
    const a = h.conversations.create({ userId: OWNER, title: "A" });
    const b = h.conversations.create({ userId: OWNER, title: "B" });
    const c = h.conversations.create({ userId: OWNER, title: "C" });

    const call = h.registry.execute("chats.congregate", {
      question: "which?",
      targets: [
        { id: a.id, message: "one" },
        { id: b.id, message: "two" },
        { id: c.id, message: "three" },
      ],
    });
    // All three are in flight before any has answered: a fan-out, not a loop.
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(3);
    release();

    const res = await call;
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content) as Members;
    expect(out.question).toBe("which?");
    expect(out.members.map((m) => m.title)).toEqual(["A", "B", "C"]);
    expect(out.members.every((m) => m.ok)).toBe(true);
    expect(out.members[1]?.reply).toBe(`${b.id}: two`);
  });

  it("reports a failed member and still answers from the rest", async () => {
    const h = await harness(ws, {
      dispatch: async (id, text) => {
        if (text === "boom") throw new Error("no such tool");
        return { reply: `ok ${text}`, conversationId: id };
      },
    });
    const a = h.conversations.create({ userId: OWNER, title: "A" });
    const b = h.conversations.create({ userId: OWNER, title: "B" });

    const res = await h.registry.execute("chats.congregate", {
      targets: [
        { id: a.id, message: "fine" },
        { id: b.id, message: "boom" },
      ],
    });
    expect(res.isError).toBe(false);
    const { members } = JSON.parse(res.content) as Members;
    expect(members[0]).toMatchObject({ ok: true, reply: "ok fine" });
    expect(members[1]?.ok).toBe(false);
    expect(members[1]?.reply).toContain("no such tool");
  });

  it("gives up on a member that runs too long, without waiting on it", async () => {
    const h = await harness(ws, {
      timeoutMs: 30,
      dispatch: (id, text) =>
        text === "slow"
          ? new Promise((r) => setTimeout(() => r({ reply: "late", conversationId: id }), 500))
          : Promise.resolve({ reply: "quick", conversationId: id }),
    });
    const a = h.conversations.create({ userId: OWNER, title: "Quick" });
    const b = h.conversations.create({ userId: OWNER, title: "Slow" });

    const started = Date.now();
    const res = await h.registry.execute("chats.congregate", {
      targets: [
        { id: a.id, message: "go" },
        { id: b.id, message: "slow" },
      ],
    });
    expect(Date.now() - started).toBeLessThan(400);
    const { members } = JSON.parse(res.content) as Members;
    expect(members[0]).toMatchObject({ ok: true, reply: "quick" });
    expect(members[1]?.ok).toBe(false);
    expect(members[1]?.reply).toContain("gave up waiting");
  });

  it("refuses more than six members before making or asking anything", async () => {
    const h = await harness(ws);
    const targets = Array.from({ length: MAX_CONGREGATION + 1 }, (_, i) => ({
      title: `T${i}`,
      message: "go",
    }));
    const res = await h.registry.execute("chats.congregate", { targets });
    expect(res.isError).toBe(true);
    expect(res.content).toContain(`at most ${MAX_CONGREGATION}`);
    expect(h.conversations.list(OWNER)).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
  });

  it("refuses an empty congregation and a member with nothing to ask", async () => {
    const h = await harness(ws);
    expect((await h.registry.execute("chats.congregate", { targets: [] })).isError).toBe(true);
    const res = await h.registry.execute("chats.congregate", { targets: [{ title: "T" }] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no message");
    expect(h.conversations.list(OWNER)).toHaveLength(0);
  });

  it("keeps a project orchestrator out of another project's conversations", async () => {
    const h = await harness(ws, { scope: "books" });
    const mine = h.conversations.create({ userId: OWNER, title: "Shelf", projectSlug: "books" });
    const theirs = h.conversations.create({ userId: OWNER, title: "Drafts", projectSlug: "notes" });

    const res = await h.registry.execute("chats.congregate", {
      targets: [
        { id: mine.id, message: "go" },
        { id: theirs.id, message: "go" },
        { title: "New", message: "go" },
      ],
    });
    expect(res.isError).toBe(true);
    // Absent, not forbidden: it must not learn the other one exists.
    expect(res.content).toContain(`no such conversation: ${theirs.id}`);
    // And nothing happened to the members that were in scope.
    expect(h.asked).toHaveLength(0);
    expect(h.conversations.list(OWNER).some((c) => c.title === "New")).toBe(false);
  });

  it("will not ask a hidden conversation, such as the dispatcher itself", async () => {
    const h = await harness(ws, { hide: [DISPATCHER] });
    h.conversations.create({ id: DISPATCHER, userId: OWNER, title: "KOS" });
    const res = await h.registry.execute("chats.congregate", {
      targets: [{ id: DISPATCHER, message: "go" }],
    });
    expect(res.isError).toBe(true);
    expect(h.asked).toHaveLength(0);
  });

  it("stamps new members with the caller's project and their brief", async () => {
    const h = await harness(ws, { scope: "books" });
    const res = await h.registry.execute("chats.congregate", {
      targets: [
        { title: "Cost Angle", brief: "Think about money.", message: "price it" },
        { title: "Risk Angle", message: "what could go wrong" },
      ],
    });
    expect(res.isError).toBe(false);

    const made = h.conversations.list(OWNER);
    expect(made.map((c) => c.title).sort()).toEqual(["Cost Angle", "Risk Angle"]);
    for (const c of made) expect(c.projectSlug).toBe("books");
    expect(made.find((c) => c.title === "Cost Angle")?.brief).toBe("Think about money.");
    expect(made.find((c) => c.title === "Risk Angle")?.brief).toBeNull();
    // Each new member was asked its own message.
    expect(h.asked.map((a) => a.text).sort()).toEqual(["price it", "what could go wrong"]);
    const { members } = JSON.parse(res.content) as Members;
    expect(members.map((m) => m.id).sort()).toEqual(made.map((c) => c.id).sort());
  });

  it("tells the dispatcher who it is waiting on, at the start and as each settles", async () => {
    const h = await harness(ws, {
      dispatch: async (id, text) => {
        if (text === "boom") throw new Error("down");
        return { reply: "ok", conversationId: id };
      },
    });
    const a = h.conversations.create({ userId: OWNER, title: "A" });

    await h.registry.execute("chats.congregate", {
      targets: [
        { id: a.id, message: "go" },
        { title: "B", message: "boom" },
      ],
    });
    // One roster at the start, then one per member.
    expect(h.rosters).toHaveLength(3);
    expect(h.rosters.every((r) => r.from === DISPATCHER)).toBe(true);
    expect(h.rosters[0]?.members.map((m) => m.title)).toEqual(["A", "B"]);
    expect(h.rosters[0]?.members.map((m) => m.status)).toEqual(["working", "working"]);
    expect(h.rosters.at(-1)?.members.map((m) => m.status)).toEqual(["done", "failed"]);
    // Each roster is its own copy, so an earlier one does not change under
    // whoever is holding it.
    expect(h.rosters[0]?.members[0]?.status).toBe("working");
  });

  it("says nothing about the roster when no conversation is dispatching", async () => {
    const h = await harness(ws, { anonymous: true });
    const a = h.conversations.create({ userId: OWNER, title: "A" });
    const res = await h.registry.execute("chats.congregate", {
      targets: [{ id: a.id, message: "go" }],
    });
    expect(res.isError).toBe(false);
    expect(h.rosters).toHaveLength(0);
  });

  it("cuts a very long reply and says where the rest is", async () => {
    const h = await harness(ws, {
      dispatch: async (id) => ({ reply: "x".repeat(9_000), conversationId: id }),
    });
    const a = h.conversations.create({ userId: OWNER, title: "A" });
    const res = await h.registry.execute("chats.congregate", {
      targets: [{ id: a.id, message: "go" }],
    });
    const { members } = JSON.parse(res.content) as Members;
    expect(members[0]?.reply.length).toBeLessThan(9_000);
    expect(members[0]?.reply).toContain("full reply is in that conversation");
  });
});
