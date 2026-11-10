import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import { OWNER_ONLY, roomConversationId, type OutboundMessage } from "../channels/types.js";
import type { ModelMessage } from "../models/types.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { guestOrigin, type GuestOrigin } from "./caller.js";
import { Kernel } from "./kernel.js";
import { createPressHandler } from "./press.js";

type Result = { content: string; isError?: boolean };

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], stopReason: "end_turn" as const, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
const call = (name: string, input: Record<string, unknown>) => ({ content: [{ type: "tool_use" as const, id: "t1", name, input }], stopReason: "tool_use" as const, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

/**
 * A guest-visible channel bound to the owner's own working chat: a guest's
 * turn there runs in the place's own room, which holds only what was said
 * in the place, while the binding, and the owner's chat, stay the owner's.
 */
describe("a guest-visible place's room", () => {
  let root: string;
  let kernel: Kernel;
  /** Every model request, as text, newest last. */
  let asked: string[];
  /** The guest marker each sql call ran under. */
  let marked: (GuestOrigin | undefined)[];
  let board: string;
  let inference: Inference;
  /** KOS back up after a restart, over the same workspace. */
  const restart = async (): Promise<void> => {
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, notify: async () => undefined, chrome: { port: 1, exists: () => false } });
  };
  const guest = { id: "g1", name: "Ana" };
  const place = { kind: "channel" as const, id: "c1", name: "leetcode" };
  const room = roomConversationId("c1");

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-rooms-"));
    asked = [];
    marked = [];
    inference = {
      async generate(_task, req) {
        asked.push(JSON.stringify(req));
        const sent = JSON.stringify(req.messages.at(-1));
        if (sent.includes("tool_result")) return reply("linked");
        if (sent.includes("LINK")) return call("sql", { sql: "INSERT INTO daily_accounts (discord_user_id, leetcode_username) VALUES (?, ?)", params: ["g1", "ana_lc"] });
        if (sent.includes("SHOW")) return call("sql", { sql: "SELECT leetcode_username FROM daily_accounts" });
        if (sent.includes("BUTTON")) return call("notify", { to: "owner", text: "Press to link", buttons: [{ label: "Link" }] });
        return reply("ok");
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, notify: async () => undefined, chrome: { port: 1, exists: () => false } });
    kernel.standUpProject({ name: "Daily", type: "tracker" });
    kernel.workspace.db.exec("CREATE TABLE daily_accounts (discord_user_id TEXT, leetcode_username TEXT)");
    board = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "LeetCode Board", projectSlug: "daily", brief: "You answer members about the board: link an account when asked." }).id;
    kernel.setChannelAudience(board, "guests");
    // The owner's own work in the board chat, on the dashboard.
    await kernel.handleMessage("OWNER-SECRET plan for the board", { userId: kernel.profile.ownerId, sessionId: board, owner: true });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A guest's words in #leetcode, as the surface hands them on: to the place's room, seeded with its home. */
  const guestSays = (text: string) =>
    kernel.handleChannelTurn({ text, userId: kernel.profile.ownerId, channel: "discord", conversationId: room, newIn: { room: { home: board, key: board, name: "leetcode" } }, guest, room: place });
  /** The owner's words in #leetcode: to the chat it is bound to. */
  const ownerSays = (text: string) => kernel.handleChannelTurn({ text, userId: kernel.profile.ownerId, channel: "discord", conversationId: board, room: place });
  const said = (id: string): string => JSON.stringify(kernel.sessions.get(id));
  const results = (id: string): Result[] => kernel.sessions.get(id).flatMap((m: ModelMessage) => m.content.filter((b) => b.type === "tool_result")) as Result[];

  it("runs a guest's turn in a room of its own, in the home's project, with none of the owner's chat", async () => {
    const res = await guestSays("hi, how do I join?");
    expect(res.conversationId).toBe(room);
    const made = kernel.conversations.get(room)!;
    expect(made).toMatchObject({ title: "#leetcode room", projectSlug: "daily" });
    expect(made.brief).toMatch(/You answer the members in #leetcode/);
    // The home's brief governs what members may ask, read afresh.
    expect(made.brief).toMatch(/link an account when asked/);
    const prompt = asked.at(-1)!;
    expect(prompt).toContain("hi, how do I join?");
    expect(prompt).not.toContain("OWNER-SECRET");
    expect(said(room)).not.toContain("OWNER-SECRET");
    // The owner's chat hears nothing of it.
    expect(said(board)).not.toContain("how do I join");
    // The room is a chat of the project like any other, on the dashboard; no thread of the project's stands for it.
    expect(kernel.conversations.list(kernel.profile.ownerId).filter((c) => c.projectSlug === "daily").map((c) => c.id)).toContain(room);
    expect(kernel.threadHome(room)).toBeUndefined();
    expect(kernel.surfaceChannels().find((c) => c.key === "project:daily")?.threads?.map((t) => t.conversationId)).not.toContain(room);
    expect(kernel.audienceOf(room)).toBe("guests");
  });

  it("reuses the room for every guest turn after, and takes an edit to the home's brief", async () => {
    await guestSays("first");
    kernel.conversations.setBrief(board, "Members may link accounts and ask for streaks.");
    await guestSays("second");
    const rooms = kernel.conversations.list(kernel.profile.ownerId).filter((c) => c.id.startsWith("discord:room:"));
    expect(rooms.map((c) => c.id)).toEqual([room]);
    expect(said(room)).toContain("first");
    expect(said(room)).toContain("second");
    expect(kernel.conversations.get(room)!.brief).toMatch(/ask for streaks/);
  });

  it("keeps the owner's dashboard work out of the room, and their words in the channel in both", async () => {
    await guestSays("hello");
    await kernel.handleMessage("OWNER-DASHBOARD-ONLY notes", { userId: kernel.profile.ownerId, sessionId: board, owner: true });
    expect(said(room)).not.toContain("OWNER-DASHBOARD-ONLY");
    // Said in #leetcode, in front of its members: run in the owner's chat, kept in the room with the answer.
    const res = await ownerSays("welcome Ana");
    expect(res.conversationId).toBe(board);
    expect(said(board)).toContain("welcome Ana");
    const kept = kernel.sessions.get(room).slice(-2);
    expect(kept.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(kept[0])).toContain("[the owner, in the channel] welcome Ana");
    expect(JSON.stringify(kept[1])).toContain("ok");
    // The next guest turn sees what the owner said there, and still none of the owner's chat.
    await guestSays("thanks");
    expect(asked.at(-1)).toContain("welcome Ana");
    expect(asked.at(-1)).not.toContain("OWNER-SECRET");
    expect(asked.at(-1)).not.toContain("OWNER-DASHBOARD-ONLY");
  });

  it("keeps nothing in a room no guest has made yet", async () => {
    await ownerSays("morning all");
    expect(kernel.conversations.get(room)).toBeUndefined();
  });

  it("lets a guest's sql in the room's project link an account, under the room's marker", async () => {
    const real = kernel.workspace.db.prepare.bind(kernel.workspace.db);
    vi.spyOn(kernel.workspace.db, "prepare").mockImplementation((sql: string) => {
      if (/daily_accounts/.test(sql)) marked.push(guestOrigin());
      return real(sql);
    });
    await guestSays("LINK me as ana_lc");
    expect(results(room).at(-1)?.isError).not.toBe(true);
    await guestSays("SHOW the accounts");
    expect(results(room).at(-1)?.content).toContain("ana_lc");
    expect(marked.filter(Boolean)[0]).toEqual({ project: "daily", chat: room, home: board });
  });

  it("runs a guest's press in the room, for a button of the room's own project alone", async () => {
    const sent: OutboundMessage[] = [];
    const respond = { openForm: async () => undefined, working: async () => undefined, followUp: async () => undefined, send: async (m: OutboundMessage) => void sent.push(m) };
    const handle = createPressHandler({ kernel, channel: "discord" });
    // A button the owner's board chat put in #leetcode, pressed before the guest ever spoke there.
    const fromBoard = kernel.presses.register({ conversationId: board, buttonId: "link", label: "Link my LeetCode" });
    await handle({ buttonId: "", label: "Link my LeetCode", token: fromBoard, pressedBy: "g1", guest, room, newIn: { room: { home: board, key: board, name: "leetcode" } } }, respond);
    expect(said(room)).toContain("Link my LeetCode");
    expect(said(board)).not.toContain("Link my LeetCode");
    // One from another project's chat is the owner's to press.
    kernel.standUpProject({ name: "Other", type: "tracker" });
    const elsewhere = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Private", projectSlug: "other" });
    const foreign = kernel.presses.register({ conversationId: elsewhere.id, buttonId: "x", label: "Secret" });
    await handle({ buttonId: "", label: "Secret", token: foreign, pressedBy: "g1", guest, room }, respond);
    expect(sent.at(-1)?.text).toBe(OWNER_ONLY);
    expect(said(elsewhere.id)).not.toContain("Secret");
    expect(said(room)).not.toContain("Secret");
  });

  it("routes the buttons a guest's turn sends back to the room", async () => {
    const tokens: { replyTo?: string }[] = [];
    const real = kernel.presses.register.bind(kernel.presses);
    vi.spyOn(kernel.presses, "register").mockImplementation((route) => {
      tokens.push({ replyTo: route.conversationId });
      return real(route);
    });
    await guestSays("BUTTON please");
    expect(tokens).toEqual([{ replyTo: room }]);
  });

  it("replays a guest's queued words in the room while the place is open, and holds them once it is shut", async () => {
    await guestSays("first");
    const flags = { guest, owner: false, origin: "system" as const, channel: "discord" };
    kernel.pending.add(room, "[Ana, a guest in the channel] QUEUED-OPEN", [], { via: "discord", from: { kind: "guest", name: "Ana", id: "g1" } }, flags);
    await restart();
    kernel.replayQueued();
    await vi.waitFor(() => expect(said(room)).toContain("QUEUED-OPEN"));
    await vi.waitFor(() => expect(kernel.busyConversations()).not.toContain(room));
    expect(said(board)).not.toContain("QUEUED-OPEN");
    kernel.setChannelAudience(board, "owner");
    kernel.pending.add(room, "[Ana, a guest in the channel] QUEUED-SHUT", [], undefined, flags);
    await restart();
    kernel.replayQueued();
    expect(said(room)).toMatch(/1 queued message was not run after a restart; resend\?\\n> \[Ana, a guest in the channel\] QUEUED-SHUT/);
  });

  it("keeps the room's home on an approval's guest marker", () => {
    const marker = { project: "daily", chat: room, home: board };
    const queued = kernel.approvals.enqueue({ tool: "sql", args: {}, riskTier: "risky", conversationId: room, guest: marker });
    expect(kernel.approvals.get(queued.id)?.guest).toEqual(marker);
  });
});
