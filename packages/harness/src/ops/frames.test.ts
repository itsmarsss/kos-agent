import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { FrameStore } from "./frames.js";

/**
 * A picture per browser step, keyed to the call it followed, capped per
 * conversation so a long session stays a short film.
 */
describe("the frame store", () => {
  let root: string;
  let ws: Workspace;
  let frames: FrameStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-frames-"));
    ws = Workspace.open(root);
    let t = 0;
    frames = new FrameStore(ws.db, () => ++t);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a frame with its call, serves the picture on its own, and maps a transcript's calls", () => {
    const a = frames.add({ conversationId: "c1", toolUseId: "tu_1", tool: "browser.visit", picture: "AAAA" });
    const b = frames.add({ conversationId: "c1", tool: "browser.act", picture: "BBBB" });
    frames.add({ conversationId: "c2", toolUseId: "tu_9", tool: "browser.visit", picture: "CCCC" });
    expect(a).toEqual({ id: 1, conversationId: "c1", toolUseId: "tu_1", tool: "browser.visit", site: null, createdAt: 1 });
    expect(b.toolUseId).toBeNull();
    expect(frames.pictureOf(a.id)).toBe("AAAA");
    expect(frames.pictureOf(99)).toBeUndefined();
    expect(frames.listFor("c1").map((f) => f.id)).toEqual([1, 2]);
    expect([...frames.byToolUse("c1")]).toEqual([["tu_1", 1]]);
  });

  it("keeps the site a browser frame shows, and none for a screen", () => {
    const web = frames.add({ conversationId: "c1", tool: "browser.act", picture: "AAAA", site: "example.com" });
    const screen = frames.add({ conversationId: "c1", tool: "computer.act", picture: "BBBB" });
    expect(web.site).toBe("example.com");
    expect(frames.shown(web.id)).toEqual({ image: "AAAA", site: "example.com" });
    expect(frames.shown(screen.id)).toEqual({ image: "BBBB" });
    expect(frames.shown(99)).toBeUndefined();
  });

  it("adds the site column to a table made before it, keeping the frames there", () => {
    const old = mkdtempSync(join(tmpdir(), "kos-frames-old-"));
    const w = Workspace.open(old);
    try {
      w.db.exec(`CREATE TABLE browser_frames (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, tool_use_id TEXT, tool TEXT NOT NULL, created_at INTEGER NOT NULL, picture TEXT NOT NULL)`);
      w.db.prepare(`INSERT INTO browser_frames (conversation_id, tool, created_at, picture) VALUES ('c1', 'browser.visit', 1, 'OLD')`).run();
      const store = new FrameStore(w.db);
      expect(store.get(1)?.site).toBeNull();
      expect(store.pictureOf(1)).toBe("OLD");
      expect(store.add({ conversationId: "c1", tool: "browser.act", picture: "NEW", site: "a.test" }).site).toBe("a.test");
      // Opening it again does not add the column twice.
      expect(() => new FrameStore(w.db)).not.toThrow();
    } finally {
      w.close();
      rmSync(old, { recursive: true, force: true });
    }
  });

  it("lets a conversation's oldest go past the cap", () => {
    for (let i = 0; i < 160; i++) frames.add({ conversationId: "c1", toolUseId: `tu_${i}`, tool: "browser.visit", picture: "X" });
    const kept = frames.listFor("c1");
    expect(kept).toHaveLength(150);
    expect(kept[0]?.toolUseId).toBe("tu_10");
    expect(frames.pictureOf(1)).toBeUndefined();
  });
});
