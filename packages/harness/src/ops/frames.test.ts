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
    const b = frames.add({ conversationId: "c1", tool: "mcp.browser.agent_browser_click", picture: "BBBB" });
    frames.add({ conversationId: "c2", toolUseId: "tu_9", tool: "browser.visit", picture: "CCCC" });
    expect(a).toEqual({ id: 1, conversationId: "c1", toolUseId: "tu_1", tool: "browser.visit", createdAt: 1 });
    expect(b.toolUseId).toBeNull();
    expect(frames.pictureOf(a.id)).toBe("AAAA");
    expect(frames.pictureOf(99)).toBeUndefined();
    expect(frames.listFor("c1").map((f) => f.id)).toEqual([1, 2]);
    expect([...frames.byToolUse("c1")]).toEqual([["tu_1", 1]]);
  });

  it("lets a conversation's oldest go past the cap", () => {
    for (let i = 0; i < 160; i++) frames.add({ conversationId: "c1", toolUseId: `tu_${i}`, tool: "browser.visit", picture: "X" });
    const kept = frames.listFor("c1");
    expect(kept).toHaveLength(150);
    expect(kept[0]?.toolUseId).toBe("tu_10");
    expect(frames.pictureOf(1)).toBeUndefined();
  });
});
