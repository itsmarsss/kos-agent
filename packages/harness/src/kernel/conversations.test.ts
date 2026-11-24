import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { blobOf, ConversationStore, isProjectChat, titleFromText } from "./conversations.js";
import { SessionStore } from "./session.js";

describe("titleFromText", () => {
  it("uses the opening message", () => {
    expect(titleFromText("what did I spend on coffee")).toBe(
      "what did I spend on coffee",
    );
  });

  it("truncates on a word boundary", () => {
    const t = titleFromText("a".repeat(20) + " " + "b".repeat(80));
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(61);
  });

  it("never holds a key or an address, since a title goes everywhere", () => {
    expect(titleFromText("email jane@example.com my password is hunter2 please")).toBe("email my please");
    expect(titleFromText("sk-ant-api03-abcdefghijklmnop")).toBe("New conversation");
  });

  it("falls back for empty input", () => {
    expect(titleFromText("   ")).toBe("New conversation");
  });
});

describe("ConversationStore", () => {
  let root: string;
  let ws: Workspace;
  let store: ConversationStore;
  let clock: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-conv-"));
    ws = Workspace.open(root);
    clock = 1000;
    store = new ConversationStore(ws.db, () => clock);
  });

  it("says when a chat is made, once", () => {
    const made: string[] = [];
    store.onCreated((id) => void made.push(id));
    store.create({ id: "project:garden", userId: "owner", title: "Garden" });
    store.create({ id: "project:garden", userId: "owner", title: "Garden" });
    expect(made).toEqual(["project:garden"]);
  });

  it("says when a chat's title changes, however it changes, and not when it does not", () => {
    const told: [string, string][] = [];
    store.onRenamed((id, title) => void told.push([id, title]));
    const c = store.create({ userId: "owner" });
    store.touch(c.id, "plan the garden");
    store.touch(c.id, "another message");
    store.rename(c.id, "Garden");
    store.rename(c.id, "Garden");
    expect(told).toEqual([[c.id, "plan the garden"], [c.id, "Garden"]]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("remembers when the owner last read a thread", () => {
    const made = store.create({ userId: "owner", title: "Beds" });
    expect(made.readAt).toBeNull();
    clock = 2000;
    store.markRead(made.id);
    expect(store.get(made.id)?.readAt).toBe(2000);
    // Later activity is newer than the read, which is what unread means.
    clock = 3000;
    store.touch(made.id);
    const after = store.get(made.id)!;
    expect(after.updatedAt).toBeGreaterThan(after.readAt!);
  });

  it("counts what was there before read tracking as read", () => {
    const made = store.create({ userId: "owner", title: "Old" });
    ws.db.exec(`ALTER TABLE conversations DROP COLUMN read_at`);
    const upgraded = new ConversationStore(ws.db, () => clock);
    expect(upgraded.get(made.id)?.readAt).toBe(made.updatedAt);
  });

  it("moves a conversation into a project and out again", () => {
    const made = store.create({ userId: "owner", title: "Fix: Nightly" });
    expect(store.moveToProject(made.id, "maintenance")?.projectSlug).toBe("maintenance");
    expect(store.moveToProject(made.id, null)?.projectSlug).toBeNull();
  });

  it("creates conversations with distinct ids", () => {
    const a = store.create({ userId: "owner" });
    const b = store.create({ userId: "owner" });
    expect(a.id).not.toBe(b.id);
    expect(store.list("owner")).toHaveLength(2);
  });

  it("orders by most recently touched", () => {
    const a = store.create({ userId: "owner", title: "first" });
    clock = 2000;
    store.create({ userId: "owner", title: "second" });
    clock = 3000;
    store.touch(a.id);
    expect(store.list("owner").map((c) => c.title)).toEqual(["first", "second"]);
  });

  it("adopts a title from the first message, then leaves it alone", () => {
    const c = store.create({ userId: "owner" });
    store.touch(c.id, "help me plan the shoot");
    expect(store.get(c.id)?.title).toBe("help me plan the shoot");
    store.touch(c.id, "and also book a van");
    expect(store.get(c.id)?.title).toBe("help me plan the shoot");
  });

  it("keeps a renamed title across later messages", () => {
    const c = store.create({ userId: "owner", title: "Shoot" });
    store.touch(c.id, "something else entirely");
    expect(store.get(c.id)?.title).toBe("Shoot");
  });

  it("scopes lists to the user", () => {
    store.create({ userId: "owner" });
    store.create({ userId: "someone-else" });
    expect(store.list("owner")).toHaveLength(1);
  });

  it("hides archived conversations unless asked", () => {
    const c = store.create({ userId: "owner" });
    store.setArchived(c.id, true);
    expect(store.list("owner")).toHaveLength(0);
    expect(store.list("owner", { includeArchived: true })).toHaveLength(1);
  });

  it("deletes the transcript along with the conversation", () => {
    const sessions = new SessionStore(ws.db);
    const c = store.create({ userId: "owner" });
    sessions.record(c.id, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(sessions.get(c.id)).toHaveLength(1);

    expect(store.remove(c.id)).toBe(true);
    expect(sessions.get(c.id)).toEqual([]);
    expect(store.get(c.id)).toBeUndefined();
  });

  it("tracks an active conversation per surface", () => {
    const a = store.create({ userId: "owner" });
    const b = store.create({ userId: "owner" });
    store.setActive("discord", "owner", a.id);
    store.setActive("dashboard", "owner", b.id);
    // Two surfaces can sit on different conversations at the same time.
    expect(store.activeFor("discord", "owner")).toBe(a.id);
    expect(store.activeFor("dashboard", "owner")).toBe(b.id);
  });

  it("ignores a pointer at a deleted conversation", () => {
    const a = store.create({ userId: "owner" });
    store.setActive("discord", "owner", a.id);
    store.remove(a.id);
    expect(store.activeFor("discord", "owner")).toBeUndefined();
  });
});

describe("whose a thread is", () => {
  const blobs = new Set(["follow-ups"]);
  const standing = { blob: (name: string) => blobs.has(name) };

  it("keeps a blob's work for a project under the blob while the blob exists, and gives it back once it is gone", () => {
    // As a blob dispatched from Career was stored before, with no change to the row.
    const asked = { projectSlug: "interview_prep", role: "follow-ups" };
    expect(blobOf(asked, standing)).toBe("follow-ups");
    expect(isProjectChat(asked, "interview_prep", standing)).toBe(false);

    const own = { projectSlug: "interview_prep", role: null };
    expect(isProjectChat(own, "interview_prep", standing)).toBe(true);
    expect(isProjectChat(own, "garden", standing)).toBe(false);
    expect(blobOf(own, standing)).toBeNull();

    // The blob removed: nothing stands for it, so the thread is the project's again.
    blobs.delete("follow-ups");
    expect(blobOf(asked, standing)).toBeNull();
    expect(isProjectChat(asked, "interview_prep", standing)).toBe(true);
  });
});
