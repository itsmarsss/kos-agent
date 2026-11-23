import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { RunsLog } from "./runs.js";

describe("RunsLog", () => {
  let root: string;
  let ws: Workspace;
  let clock: number;
  let runs: RunsLog;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-runs-"));
    ws = Workspace.open(root);
    clock = 1000;
    runs = new RunsLog(ws.db, () => clock);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("records timing and status across start/finish", () => {
    const id = runs.start("cron", "job:1");
    clock = 1500;
    runs.finish(id, "ok");
    const [rec] = runs.recent();
    expect(rec?.status).toBe("ok");
    expect(rec?.startedAt).toBe(1000);
    expect(rec?.finishedAt).toBe(1500);
    expect(rec?.durationMs).toBe(500);
  });

  it("reads a window whole, oldest first, from when each run started", () => {
    runs.start("chat", "a");
    clock = 2000;
    const inside = runs.start("cron", "1");
    clock = 3000;
    runs.finish(inside, "error", "boom");
    runs.start("chat", "b");
    expect(runs.since(2000).map((r) => [r.kind, r.ref, r.status])).toEqual([
      ["cron", "1", "error"],
      ["chat", "b", "running"],
    ]);
  });

  it("knows one thing's finished runs, newest first, and how many there were", () => {
    const first = runs.start("cron", "7");
    runs.finish(first, "ok");
    const other = runs.start("cron", "8");
    runs.finish(other, "ok");
    const second = runs.start("cron", "7");
    runs.finish(second, "error", "boom");
    runs.start("cron", "7");
    expect(runs.finishedFor("cron", "7").map((r) => [r.id, r.status])).toEqual([[second, "error"], [first, "ok"]]);
    expect(runs.finishedFor("cron", "7", 1).map((r) => r.id)).toEqual([second]);
    expect(runs.countFinished("cron", "7")).toBe(2);
    expect(runs.countFinished("cron", "9")).toBe(0);
  });

  it("captures errors and surfaces them via failures()", () => {
    const ok = runs.start("cron", "good");
    runs.finish(ok, "ok");
    const bad = runs.start("cron", "bad");
    runs.finish(bad, "error", "exploded");
    const fails = runs.failures();
    expect(fails).toHaveLength(1);
    expect(fails[0]?.error).toBe("exploded");
  });

  it("leaves an unfinished run marked running", () => {
    runs.start("job", "x");
    const [rec] = runs.recent();
    expect(rec?.status).toBe("running");
    expect(rec?.finishedAt).toBeNull();
  });

  it("closes every open run as interrupted, and counts it among the failures", () => {
    const open = runs.start("chat", "cron:28");
    const done = runs.start("cron", "28");
    runs.finish(done, "ok");
    clock = 4000;
    const cut = runs.interruptRunning("KOS restarted while it was running.");
    expect(cut.map((r) => r.id)).toEqual([open]);
    expect(runs.get(open)).toMatchObject({ status: "interrupted", error: "KOS restarted while it was running.", finishedAt: 4000, durationMs: 3000 });
    expect(runs.get(done)?.status).toBe("ok");
    expect(runs.failures().map((r) => r.id)).toEqual([open]);
    expect(runs.interruptRunning("again")).toEqual([]);
  });
});
