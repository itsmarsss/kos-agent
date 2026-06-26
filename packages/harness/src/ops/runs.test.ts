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
});
