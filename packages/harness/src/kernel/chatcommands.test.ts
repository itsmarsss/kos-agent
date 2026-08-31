import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ConversationStore } from "./conversations.js";
import { parseChatCommand, resolveConversation, runChatCommand } from "./chatcommands.js";

describe("parseChatCommand", () => {
  it("recognizes the verbs and their aliases", () => {
    expect(parseChatCommand("/new")).toEqual({ kind: "new" });
    expect(parseChatCommand("/n shoot plan")).toEqual({ kind: "new", title: "shoot plan" });
    expect(parseChatCommand("/chats")).toEqual({ kind: "list" });
    expect(parseChatCommand("/ls")).toEqual({ kind: "list" });
    expect(parseChatCommand("/switch 2")).toEqual({ kind: "switch", target: "2" });
    expect(parseChatCommand("/rename Budget")).toEqual({ kind: "rename", title: "Budget" });
    expect(parseChatCommand("/archive")).toEqual({ kind: "archive" });
  });

  it("is case-insensitive on the verb", () => {
    expect(parseChatCommand("/NEW")).toEqual({ kind: "new" });
  });

  it("leaves ordinary messages alone", () => {
    // A message that merely contains a slash is not a command.
    expect(parseChatCommand("what is 10/2")).toBeNull();
    expect(parseChatCommand("add a note about the a/b test")).toBeNull();
    expect(parseChatCommand("/notacommand")).toBeNull();
    expect(parseChatCommand("")).toBeNull();
  });

  it("asks for help when a required argument is missing", () => {
    expect(parseChatCommand("/switch")).toEqual({ kind: "help" });
    expect(parseChatCommand("/rename")).toEqual({ kind: "help" });
  });
});

describe("resolveConversation", () => {
  const list = [
    { id: "a", title: "Budget review", userId: "o", channel: null, createdAt: 0, updatedAt: 0, archived: false },
    { id: "b", title: "Shoot plan", userId: "o", channel: null, createdAt: 0, updatedAt: 0, archived: false },
  ];

  it("prefers the listed position", () => {
    expect(resolveConversation(list, "2")?.id).toBe("b");
  });

  it("matches an id, then a title prefix", () => {
    expect(resolveConversation(list, "a")?.id).toBe("a");
    expect(resolveConversation(list, "shoot")?.id).toBe("b");
  });

  it("returns nothing for an out-of-range position or no match", () => {
    expect(resolveConversation(list, "9")).toBeUndefined();
    expect(resolveConversation(list, "nope")).toBeUndefined();
  });
});

describe("runChatCommand", () => {
  let root: string;
  let ws: Workspace;
  let conversations: ConversationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-cmd-"));
    ws = Workspace.open(root);
    conversations = new ConversationStore(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  function ctx(currentId: string) {
    return { conversations, channel: "discord", userId: "owner", currentId };
  }

  it("starts a conversation and points the surface at it", () => {
    const first = conversations.create({ userId: "owner", title: "Main" });
    const res = runChatCommand({ kind: "new", title: "Shoot" }, ctx(first.id));
    expect(res.switchedTo).toBeTruthy();
    expect(res.switchedTo).not.toBe(first.id);
    expect(conversations.activeFor("discord", "owner")).toBe(res.switchedTo);
  });

  it("marks where you are in the list", () => {
    const a = conversations.create({ userId: "owner", title: "Main" });
    conversations.create({ userId: "owner", title: "Shoot" });
    const res = runChatCommand({ kind: "list" }, ctx(a.id));
    expect(res.reply).toContain("Main");
    expect(res.reply).toContain("← here");
  });

  it("switches by position", () => {
    conversations.create({ userId: "owner", title: "Main" });
    const b = conversations.create({ userId: "owner", title: "Shoot" });
    // list() is most-recent first, so Shoot is position 1.
    const res = runChatCommand({ kind: "switch", target: "1" }, ctx("nope"));
    expect(res.switchedTo).toBe(b.id);
  });

  it("says so when a switch target does not exist", () => {
    const a = conversations.create({ userId: "owner", title: "Main" });
    const res = runChatCommand({ kind: "switch", target: "zzz" }, ctx(a.id));
    expect(res.switchedTo).toBeUndefined();
    expect(res.reply).toMatch(/No conversation matches/);
  });

  it("renames the current conversation", () => {
    const a = conversations.create({ userId: "owner", title: "Main" });
    runChatCommand({ kind: "rename", title: "Budget 2026" }, ctx(a.id));
    expect(conversations.get(a.id)?.title).toBe("Budget 2026");
  });

  it("archiving lands you on another conversation, never a dead one", () => {
    const a = conversations.create({ userId: "owner", title: "Main" });
    const b = conversations.create({ userId: "owner", title: "Shoot" });
    const res = runChatCommand({ kind: "archive" }, ctx(a.id));
    expect(conversations.get(a.id)?.archived).toBe(true);
    expect(res.switchedTo).toBe(b.id);
  });

  it("archiving the last conversation creates a fresh one", () => {
    const only = conversations.create({ userId: "owner", title: "Main" });
    const res = runChatCommand({ kind: "archive" }, ctx(only.id));
    expect(res.switchedTo).toBeTruthy();
    expect(res.switchedTo).not.toBe(only.id);
    expect(conversations.list("owner")).toHaveLength(1);
  });
});
