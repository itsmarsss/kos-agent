import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { PageWatchStore, lineDiff, normalizeText } from "./watches.js";

/**
 * A page read on a schedule and compared with last time: the first look
 * has nothing to compare with, a still page is no news, and a changed one
 * says which lines went and came.
 */
describe("watching a page", () => {
  let root: string;
  let ws: Workspace;
  let clock: number;
  let store: PageWatchStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-watch-"));
    ws = Workspace.open(root);
    clock = 1_000_000;
    store = new PageWatchStore(ws.db, () => clock);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reads lines worth comparing", () => {
    expect(normalizeText("  a   b \n\n\tc\r\n")).toEqual(["a b", "c"]);
  });

  it("says what went and what came, capped", () => {
    expect(lineDiff("one\ntwo\nthree", "one\nthree\nfour")).toBe("- two\n+ four");
    expect(lineDiff("same", "same")).toBe("");
    const many = Array.from({ length: 35 }, (_, i) => `line ${i}`).join("\n");
    expect(lineDiff("", many, 30)).toContain("+ (5 more)");
    expect(lineDiff("", `${"x".repeat(250)}`)).toMatch(/…$/);
  });

  it("knows a first look, a still page, and a change, keeping when it last moved", () => {
    const first = store.look("news", "https://news.example", "Top story: A\nSecond: B");
    expect(first).toMatchObject({ first: true, changed: false, changedAt: 1_000_000, seenAt: 1_000_000 });
    clock += 60_000;
    const same = store.look("news", "https://news.example", "Top story:   A\n\nSecond: B\n");
    expect(same).toMatchObject({ first: false, changed: false, changedAt: 1_000_000, seenAt: 1_060_000 });
    expect(same.diff).toBeUndefined();
    clock += 60_000;
    const moved = store.look("news", "https://news.example", "Top story: C\nSecond: B");
    expect(moved).toMatchObject({ first: false, changed: true, changedAt: 1_120_000 });
    expect(moved.diff).toBe("- Top story: A\n+ Top story: C");
    expect(store.list()).toEqual([{ key: "news", url: "https://news.example", seenAt: 1_120_000, changedAt: 1_120_000 }]);
    expect(store.forget("news")).toBe(true);
    expect(store.forget("news")).toBe(false);
    expect(store.look("news", "https://news.example", "x").first).toBe(true);
  });
});
