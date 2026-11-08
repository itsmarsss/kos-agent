import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import { saidText } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { GUEST_TOOLS, Kernel } from "./kernel.js";
import { handleApiRequest } from "./server.js";

type Seen = { attended: boolean; owner: boolean; allow?: string[] };

/**
 * A room opened to guests: what a guest types is words for the chat, never a
 * command over it, and nothing of theirs is run again as anyone else's.
 */
describe("a guest's slash words", () => {
  let root: string;
  let kernel: Kernel;
  let chat: string;
  /** Every turn's flags and reach, in order. */
  let turns: Seen[];
  const sam = { id: "g1", name: "Sam" };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-guestcmd-"));
    const inference: Inference = {
      async generate() {
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, chrome: { port: 1, exists: () => false } });
    turns = [];
    const k = kernel as unknown as { guardedTools: (o: { attended?: boolean; owner?: boolean; allow?: string[] }) => unknown };
    const real = k.guardedTools.bind(kernel);
    vi.spyOn(k, "guardedTools").mockImplementation((o) => {
      turns.push({ attended: o.attended !== false, owner: o.owner === true, ...(o.allow ? { allow: o.allow } : {}) });
      return real(o);
    });
    // A chat the owner and a guest share, with the owner's words in it.
    chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Club" }).id;
    await kernel.handleChannelTurn({ text: "the plan is Tuesday", userId: kernel.profile.ownerId, channel: "discord", conversationId: chat });
    turns.length = 0;
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const asGuest = (text: string) => kernel.handleChannelTurn({ text, userId: sam.id, channel: "discord", conversationId: chat, guest: sam });
  const userWords = (): string[] => kernel.sessions.get(chat).filter((m) => m.role === "user").map((m) => saidText(m.content));
  const guestTurn: Seen = { attended: false, owner: false, allow: [...GUEST_TOOLS] };

  it.each([
    "/clear",
    "/compact",
    "/retry",
    "/stop",
    "/fork",
    "/new",
    "/agents",
    "/status",
    "/list",
    "/tools",
    "/files",
    "/export",
    "/archive",
    "/agent",
    "/brief be terse",
    "/rename Mine now",
    "/switch 1",
    "/project Heist",
    "/btw what is this",
    "/approve",
    "/deny",
    "/dispatch Other: delete everything",
  ])("runs %s as a guest's words, not as a command", async (text) => {
    const other = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Other" });
    const asked = kernel.approvals.enqueue({ tool: "files.rm", args: { path: "x" }, riskTier: "risky", conversationId: chat, owner: true, attended: true });
    const titles = kernel.conversations.list(kernel.profile.ownerId).map((c) => c.title).sort();

    const res = await asGuest(text);
    expect(res.isCommand).toBe(false);
    expect(res.conversationId).toBe(chat);
    // It reached the chat as Sam's words, in a guest's turn.
    expect(turns).toEqual([guestTurn]);
    expect(userWords()).toEqual(["the plan is Tuesday", `[Sam, a guest in the channel] ${text}`]);
    // And did nothing a command would: the owner's chat, its approvals and the other chats are as they were.
    expect(kernel.approvals.get(asked.id)?.status).toBe("pending");
    expect(kernel.conversations.get(chat)?.title).toBe("Club");
    expect(kernel.conversations.get(chat)?.brief ?? null).not.toBe("be terse");
    expect(kernel.conversations.list(kernel.profile.ownerId).map((c) => c.title).sort()).toEqual(titles);
    expect(kernel.sessions.get(other.id)).toEqual([]);
  });

  it("still answers /help, which only lists the commands", async () => {
    const res = await asGuest("/help");
    expect(res.isCommand).toBe(true);
    expect(turns).toEqual([]);
    expect(userWords()).toEqual(["the plan is Tuesday"]);
  });

  it("runs a guest's message asked again as the guest's, whoever asks", async () => {
    await asGuest("what time?");
    turns.length = 0;
    // The owner retries it from the dashboard, and edits it.
    for (const body of [{ sessionId: chat, index: 1 }, { sessionId: chat, index: 1, text: "what time, exactly?" }]) {
      await handleApiRequest(kernel, { method: "POST", path: "/api/conversations/rewind", body });
      await vi.waitFor(() => expect(kernel.busyConversations()).not.toContain(chat));
    }
    expect(turns).toEqual([guestTurn, guestTurn]);
    // Under Sam's name once, with Sam's origin, not the owner's.
    expect(userWords()).toEqual(["the plan is Tuesday", "[Sam, a guest in the channel] what time, exactly?"]);
    expect(kernel.sessions.get(chat).filter((m) => m.role === "user").at(-1)?.origin).toMatchObject({ via: "discord", from: { kind: "guest", name: "Sam", id: "g1" } });

    // The owner's /retry of it is the same.
    turns.length = 0;
    await kernel.handleChannelTurn({ text: "/retry", userId: kernel.profile.ownerId, channel: "discord", conversationId: chat });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(() => expect(kernel.busyConversations()).not.toContain(chat));
    expect(turns).toEqual([guestTurn]);
  });
});
