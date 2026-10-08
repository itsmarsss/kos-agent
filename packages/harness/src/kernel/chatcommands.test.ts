import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ConversationStore } from "./conversations.js";
import { needsKernel, parseChatCommand, resolveConversation, runChatCommand } from "./chatcommands.js";

describe("parseChatCommand", () => {
  it("recognizes the verbs and their aliases", () => {
    expect(parseChatCommand("/new")).toEqual({ kind: "new" });
    expect(parseChatCommand("/n shoot plan")).toEqual({ kind: "new", title: "shoot plan" });
    expect(parseChatCommand("/chats")).toEqual({ kind: "list" });
    expect(parseChatCommand("/ls")).toEqual({ kind: "list" });
    expect(parseChatCommand("/switch 2")).toEqual({ kind: "switch", target: "2" });
    expect(parseChatCommand("/rename Budget")).toEqual({ kind: "rename", title: "Budget" });
    expect(parseChatCommand("/archive")).toEqual({ kind: "archive" });
    expect(parseChatCommand("/fork")).toEqual({ kind: "fork" });
    expect(parseChatCommand("/copy Budget B")).toEqual({ kind: "fork", title: "Budget B" });
    expect(parseChatCommand("/retry")).toEqual({ kind: "retry" });
    expect(parseChatCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseChatCommand("/brief")).toEqual({ kind: "brief" });
    expect(parseChatCommand("/brief Keep it short.")).toEqual({ kind: "brief", text: "Keep it short." });
    expect(parseChatCommand("/agent")).toEqual({ kind: "agent" });
    expect(parseChatCommand("/spawn Receipts")).toEqual({ kind: "agent", title: "Receipts" });
    expect(parseChatCommand("/agents")).toEqual({ kind: "agents" });
    expect(parseChatCommand("/dispatch Receipts: file the March ones")).toEqual({
      kind: "dispatch",
      target: "Receipts",
      task: "file the March ones",
    });
    expect(parseChatCommand("/project Kitchen redo")).toEqual({ kind: "project", name: "Kitchen redo" });
    expect(parseChatCommand("/approve")).toEqual({ kind: "approve" });
    expect(parseChatCommand("/approve #12")).toEqual({ kind: "approve", id: 12 });
    expect(parseChatCommand("/no 3")).toEqual({ kind: "deny", id: 3 });
    expect(parseChatCommand("/status")).toEqual({ kind: "status" });
    expect(parseChatCommand("/btw what was the total?")).toEqual({ kind: "btw", question: "what was the total?" });
    expect(parseChatCommand("/export")).toEqual({ kind: "export" });
    expect(parseChatCommand("/files")).toEqual({ kind: "files" });
  });

  it("knows which commands need the kernel rather than the store", () => {
    for (const text of ["/fork", "/retry", "/stop", "/agents", "/dispatch a: b", "/project p", "/approve", "/deny", "/status", "/compact", "/clear"]) {
      expect(needsKernel(parseChatCommand(text)!)).toBe(true);
    }
    for (const text of ["/new", "/chats", "/brief", "/agent", "/btw q", "/export", "/files", "/help"]) {
      expect(needsKernel(parseChatCommand(text)!)).toBe(false);
    }
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
    expect(parseChatCommand("/project")).toEqual({ kind: "help" });
    expect(parseChatCommand("/btw")).toEqual({ kind: "help" });
    // A dispatch needs both halves, either side of the colon.
    expect(parseChatCommand("/dispatch Receipts")).toEqual({ kind: "help" });
    expect(parseChatCommand("/dispatch : do it")).toEqual({ kind: "help" });
  });
});

describe("resolveConversation", () => {
  const list = [
    { id: "a", title: "Budget review", userId: "o", channel: null, createdAt: 0, updatedAt: 0, archived: false, brief: null, toolAllow: null, projectSlug: null, readAt: null },
    { id: "b", title: "Shoot plan", userId: "o", channel: null, createdAt: 0, updatedAt: 0, archived: false, brief: null, toolAllow: null, projectSlug: null, readAt: null },
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

  it("shows, sets and clears a chat's brief", () => {
    const a = conversations.create({ userId: "owner", title: "Main" });
    expect(runChatCommand({ kind: "brief" }, ctx(a.id)).reply).toMatch(/no brief/);
    runChatCommand({ kind: "brief", text: "Answer in French." }, ctx(a.id));
    expect(conversations.get(a.id)?.brief).toBe("Answer in French.");
    expect(runChatCommand({ kind: "brief" }, ctx(a.id)).reply).toContain("Answer in French.");
    runChatCommand({ kind: "brief", text: "-" }, ctx(a.id));
    expect(conversations.get(a.id)?.brief).toBeNull();
  });

  it("starts an agent in the current chat's project and moves to it", () => {
    const orchestrator = conversations.create({ userId: "owner", title: "Kitchen", projectSlug: "kitchen" });
    const res = runChatCommand({ kind: "agent", title: "Tiles" }, ctx(orchestrator.id));
    expect(res.switchedTo).toBeTruthy();
    const made = conversations.get(res.switchedTo!);
    expect(made).toMatchObject({ title: "Tiles", projectSlug: "kitchen" });
    // Untitled is named by its first message, like any chat.
    const bare = runChatCommand({ kind: "agent" }, ctx(orchestrator.id));
    expect(conversations.get(bare.switchedTo!)?.title).toBe("New conversation");

    const loose = conversations.create({ userId: "owner", title: "Main" });
    const refused = runChatCommand({ kind: "agent" }, ctx(loose.id));
    expect(refused.switchedTo).toBeUndefined();
    expect(refused.reply).toMatch(/not in a project/);
  });

  it("says a dashboard-only command is one, off the dashboard", () => {
    const a = conversations.create({ userId: "owner", title: "Main" });
    expect(runChatCommand({ kind: "export" }, ctx(a.id)).reply).toMatch(/dashboard/);
  });

  it("archiving the last conversation creates a fresh one", () => {
    const only = conversations.create({ userId: "owner", title: "Main" });
    const res = runChatCommand({ kind: "archive" }, ctx(only.id));
    expect(res.switchedTo).toBeTruthy();
    expect(res.switchedTo).not.toBe(only.id);
    expect(conversations.list("owner")).toHaveLength(1);
  });
});
