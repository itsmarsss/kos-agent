import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { listPages, readPage, writePage } from "./pages.js";
import { ReviewQueue } from "./review.js";

describe("the review queue", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-review-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps one open item per question, and remembers how it was settled", () => {
    let t = 100;
    const q = new ReviewQueue(ws.db, () => t++);
    const a = q.add("contradiction", ["project:pantry/city", "global/city"], "Lisbon vs Toronto");
    const again = q.add("contradiction", ["global/city", "project:pantry/city"], "same thing");
    expect(again.id).toBe(a.id);
    expect(q.pending()).toHaveLength(1);
    expect(q.resolve(a.id, "kept global")).toMatchObject({ resolvedAt: 101, resolution: "kept global" });
    expect(q.pending()).toEqual([]);
    expect(q.add("contradiction", ["global/city", "project:pantry/city"], "later").id).not.toBe(a.id);
    expect(q.recent().map((i) => i.id)).toHaveLength(2);
  });

  it("writes pages under memory/, inside the jail, and lists them", () => {
    const page = writePage(ws, "profile", "# Owner\n- city: Lisbon");
    expect(page.path).toBe("memory/profile.md");
    expect(readPage(ws, "profile")).toBe("# Owner\n- city: Lisbon\n");
    expect(listPages(ws).map((p) => p.name)).toEqual(["profile"]);
    expect(() => writePage(ws, "../escape", "x")).toThrow(/not a page name/);
    expect(readPage(ws, "nothing")).toBeUndefined();
  });
});
