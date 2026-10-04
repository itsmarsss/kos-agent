import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CronExecResult } from "../cron/executor.js";
import { CronStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { Workspace } from "../store/workspace.js";
import { CronService, type CronServiceDeps } from "./cronservice.js";

describe("CronService", () => {
  let root: string;
  let ws: Workspace;
  let crons: CronStore;
  let log: string[];
  let failing: { key: string }[];
  let runResult: (job: CronJob) => Promise<CronExecResult>;

  function service(over: Partial<CronServiceDeps> = {}): CronService {
    const deps: CronServiceDeps = {
      crons,
      killSwitch: { halted: false },
      selfPromptsPerHour: () => 10,
      enqueue: (work) => work(),
      runs: {
        start: (kind, ref) => { log.push(`start:${kind}:${ref}`); return 7; },
        finish: (id, status, error) => { log.push(`finish:${id}:${status}:${error ?? ""}`); },
      },
      health: { failing: () => failing, forget: (key) => { log.push(`forget:${key}`); } },
      report: (key, label, ok, error) => { log.push(`report:${key}:${label}:${ok ? "ok" : "fail"}:${error ?? ""}`); },
      backup: {
        ensureRepo: async () => { log.push("backup:ensure"); },
        snapshot: async (m) => { log.push(`backup:snapshot:${m}`); return "sha"; },
      },
      run: (job) => { log.push(`run:${job.name}`); return runResult(job); },
      ...over,
    };
    return new CronService(deps);
  }

  function job(name: string, over: Partial<Parameters<CronStore["create"]>[0]> = {}): CronJob {
    return crons.create({ name, schedule: "0 3 * * *", type: "actions", actions: [], enabled: true, ...over });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-cronsvc-"));
    ws = Workspace.open(root);
    crons = new CronStore(ws.db);
    log = [];
    failing = [];
    runResult = async () => ({ ran: true, type: "actions", results: [] });
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("puts a run on the record and tells the caretaker it went well", async () => {
    const j = job("tidy");
    const s = service();
    const res = await s.fire(j.id);
    expect(res.ok).toBe(true);
    expect(log).toEqual(["start:cron:1", "run:tidy", "finish:7:ok:", "report:cron:1:tidy:ok:"]);
    // Fired through the scheduler's own path, so the job knows it ran.
    expect(crons.get(j.id)?.lastRunAt).not.toBeNull();
    s.stop();
  });

  it("calls a run whose actions errored a failure, not a success", async () => {
    const j = job("broken");
    runResult = async () => ({ ran: true, type: "actions", results: [{ tool: "files.read", content: "no such file", isError: true }] });
    const s = service();
    const res = await s.fire(j.id);
    expect(res).toMatchObject({ ok: false, error: "files.read: no such file" });
    expect(log).toContain("finish:7:error:files.read: no such file");
    expect(log).toContain("report:cron:1:broken:fail:files.read: no such file");
    s.stop();
  });

  it("counts a condition that said not now as skipped, and healthy", async () => {
    const j = job("maybe");
    runResult = async () => ({ ran: false, reason: "condition" });
    const s = service();
    expect((await s.fire(j.id)).ok).toBe(true);
    expect(log).toContain("finish:7:skipped:");
    expect(log).toContain("report:cron:1:maybe:ok:");
    s.stop();
  });

  it("records a run that threw, and the fire says so", async () => {
    const j = job("thrower");
    runResult = async () => { throw new Error("boom"); };
    const s = service();
    const res = await s.fire(j.id);
    expect(res).toMatchObject({ ok: false, error: "boom", outcome: { fired: false, reason: "error" } });
    expect(log).toContain("finish:7:error:boom");
    expect(log).toContain("report:cron:1:thrower:fail:boom");
    s.stop();
  });

  it("runs the workspace backup outside the tool path", async () => {
    const j = job("kos.backup");
    const s = service();
    expect((await s.fire(j.id)).ok).toBe(true);
    expect(log).toEqual(["start:cron:1", "backup:ensure", "backup:snapshot:scheduled backup", "finish:7:ok:", "report:cron:1:kos.backup:ok:"]);
    s.stop();
  });

  it("will not fire a job that is already firing", async () => {
    const j = job("slow");
    let release: () => void = () => undefined;
    runResult = () => new Promise((r) => { release = () => r({ ran: true, type: "actions", results: [] }); });
    const s = service();
    const first = s.fire(j.id);
    await new Promise((r) => setTimeout(r, 10));
    const second = await s.fire(j.id);
    expect(second).toMatchObject({ ok: false, error: "slow is already running" });
    release();
    expect((await first).ok).toBe(true);
    // And once it is done, it can go again.
    runResult = async () => ({ ran: true, type: "actions", results: [] });
    expect((await s.fire(j.id)).ok).toBe(true);
    s.stop();
  });

  it("does not fire while halted, and says so", async () => {
    const j = job("halted");
    const s = service({ killSwitch: { halted: true } });
    const res = await s.fire(j.id);
    expect(res).toMatchObject({ ok: false, error: "halted", outcome: { fired: false, reason: "halted" } });
    expect(log).toEqual([]);
    s.stop();
  });

  it("forgets the failures of jobs that no longer exist, at start and on reload", async () => {
    const kept = job("kept");
    failing = [{ key: `cron:${kept.id}` }, { key: "cron:999" }, { key: "daemon:x" }];
    const s = service();
    s.start();
    expect(log).toEqual(["forget:cron:999"]);
    crons.delete(kept.id);
    s.reload();
    expect(log).toEqual(["forget:cron:999", `forget:cron:${kept.id}`, "forget:cron:999"]);
    s.stop();
  });

  it("refuses a job that does not exist", async () => {
    await expect(service().fire(42)).rejects.toThrow(/no such cron/);
  });

  it("fires each job in its own thread's lane, so two can run at once", async () => {
    const lanes: string[] = [];
    const svc = service({
      enqueue: (work, lane) => {
        lanes.push(lane);
        return work();
      },
    });
    const a = job("a");
    const b = job("b");
    await Promise.all([svc.fire(a.id), svc.fire(b.id)]);
    expect(lanes.sort()).toEqual([`cron:${a.id}`, `cron:${b.id}`].sort());
  });
});
