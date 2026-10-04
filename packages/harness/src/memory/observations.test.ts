import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ObservationStore } from "./observations.js";

describe("observations", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-obs-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("numbers a thread's notes in order and counts them", () => {
    let t = 10;
    const store = new ObservationStore(ws.db, () => t++);
    const a = store.add("c1", "we picked SQLite", 6);
    const b = store.add("c1", "then the Pi arrived", 4);
    store.add("c2", "elsewhere", 2);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(store.list("c1").map((o) => [o.seq, o.text, o.covered, o.createdAt])).toEqual([[1, "we picked SQLite", 6, 10], [2, "then the Pi arrived", 4, 11]]);
    expect(store.count("c1")).toBe(2);
    expect(store.count("c3")).toBe(0);
  });
});
