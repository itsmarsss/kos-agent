import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { CronStore } from "./store.js";

describe("CronStore", () => {
  let root: string;
  let ws: Workspace;
  let store: CronStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-cron-store-"));
    ws = Workspace.open(root);
    store = new CronStore(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips an actions job with condition and query", () => {
    const job = store.create({
      name: "weekly spend",
      schedule: "0 9 * * 1",
      type: "actions",
      query: "SELECT SUM(amount) AS total FROM tx",
      condition: { test: "total > 200" },
      actions: [{ tool: "notify", args: { text: "spent {total}" } }],
    });
    const loaded = store.get(job.id);
    expect(loaded?.type).toBe("actions");
    expect(loaded?.condition).toEqual({ test: "total > 200" });
    expect(loaded?.actions).toEqual([
      { tool: "notify", args: { text: "spent {total}" } },
    ]);
    expect(loaded?.enabled).toBe(true);
  });

  it("stores a self_prompt job", () => {
    const job = store.create({
      name: "review",
      schedule: "0 8 * * *",
      type: "self_prompt",
      prompt: "Review the budget and flag anomalies",
      projectSlug: "budget",
    });
    expect(store.get(job.id)?.prompt).toContain("Review the budget");
    expect(store.get(job.id)?.projectSlug).toBe("budget");
  });

  it("lists and filters by enabled", () => {
    const a = store.create({ name: "a", schedule: "* * * * *", type: "actions" });
    store.create({
      name: "b",
      schedule: "* * * * *",
      type: "actions",
      enabled: false,
    });
    expect(store.list()).toHaveLength(2);
    expect(store.list(true).map((j) => j.id)).toEqual([a.id]);
  });

  it("toggles enabled and deletes", () => {
    const job = store.create({ name: "x", schedule: "* * * * *", type: "actions" });
    store.setEnabled(job.id, false);
    expect(store.get(job.id)?.enabled).toBe(false);
    expect(store.delete(job.id)).toBe(true);
    expect(store.get(job.id)).toBeUndefined();
  });
});
