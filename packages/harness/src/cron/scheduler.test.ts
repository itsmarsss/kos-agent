import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { CronScheduler, type KillSwitch } from "./scheduler.js";
import { CronStore } from "./store.js";
import type { CronJob } from "./types.js";

function job(partial: Partial<CronJob>): CronJob {
  return {
    id: 1,
    name: "j",
    schedule: "0 0 1 1 *",
    type: "actions",
    query: null,
    condition: null,
    actions: null,
    prompt: null,
    projectSlug: null,
    task: "reasoning",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("CronScheduler", () => {
  let root: string;
  let ws: Workspace;
  let store: CronStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-sched-"));
    ws = Workspace.open(root);
    store = new CronStore(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("fires a job through the runner", async () => {
    const ran: number[] = [];
    const sched = new CronScheduler(store, async (j) => {
      ran.push(j.id);
      return "ok";
    });
    const out = await sched.fire(job({ id: 7 }));
    expect(out).toEqual({ fired: true, result: "ok" });
    expect(ran).toEqual([7]);
  });

  it("does not fire when the kill switch is halted", async () => {
    const killSwitch: KillSwitch = { halted: true };
    let called = false;
    const sched = new CronScheduler(
      store,
      async () => {
        called = true;
      },
      { killSwitch },
    );
    const out = await sched.fire(job({}));
    expect(out).toEqual({ fired: false, reason: "halted" });
    expect(called).toBe(false);
  });

  it("rate-limits self_prompt fires per hour", async () => {
    const sched = new CronScheduler(store, async () => "ok", {
      maxSelfPromptsPerHour: 1,
    });
    const sp = job({ type: "self_prompt" });
    expect((await sched.fire(sp)).fired).toBe(true);
    expect(await sched.fire(sp)).toEqual({ fired: false, reason: "rate_limited" });
  });

  it("reports runner errors without throwing", async () => {
    const sched = new CronScheduler(store, async () => {
      throw new Error("kaboom");
    });
    const out = await sched.fire(job({}));
    expect(out).toMatchObject({ fired: false, reason: "error", error: "kaboom" });
  });

  it("schedules only enabled, valid jobs and stops cleanly", () => {
    store.create({ name: "a", schedule: "0 0 1 1 *", type: "actions" });
    store.create({ name: "b", schedule: "0 0 1 1 *", type: "actions" });
    store.create({
      name: "disabled",
      schedule: "0 0 1 1 *",
      type: "actions",
      enabled: false,
    });
    store.create({ name: "bad", schedule: "not-a-cron", type: "actions" });

    const sched = new CronScheduler(store, async () => undefined);
    sched.start();
    expect(sched.scheduledCount()).toBe(2); // two enabled + valid
    sched.stop();
    expect(sched.scheduledCount()).toBe(0);
  });

  it("says when a held job fires next, and nothing for one it does not hold", () => {
    const hourly = store.create({ name: "hourly", schedule: "0 * * * *", type: "actions" });
    const sched = new CronScheduler(store, async () => undefined);
    sched.start();
    const runs = sched.nextRuns(hourly.id, 2);
    expect(runs).toHaveLength(2);
    expect(runs[0]!).toBeGreaterThan(Date.now());
    expect(runs[1]! - runs[0]!).toBe(3_600_000);
    expect(sched.nextRuns(hourly.id + 99, 2)).toEqual([]);
    sched.stop();
  });
});

describe("running what fell due while nothing was listening", () => {
  let root: string;
  let ws: Workspace;
  let store: CronStore;
  let fired: number[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-catchup-"));
    ws = Workspace.open(root);
    store = new CronStore(ws.db);
    fired = [];
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  function scheduler(): CronScheduler {
    return new CronScheduler(store, async (j) => {
      fired.push(j.id);
    });
  }

  /** An hourly job that last ran `agoMs` ago. */
  function hourly(agoMs: number): number {
    const created = store.create({
      name: "hourly",
      schedule: "0 * * * *",
      type: "actions",
      actions: [{ tool: "notify", args: {} }],
      enabled: true,
    });
    store.markRun(created.id, Date.now() - agoMs);
    return created.id;
  }

  it("runs a job whose moment passed while the host was down", async () => {
    /*
     * The scheduler lives in the process, so a laptop closed at noon simply
     * does not run the noon job, and nothing says so. Seen for real: the
     * nightly backup had run every night since July while the 9am and noon
     * jobs had not fired once in two days.
     */
    hourly(5 * 60 * 60_000);
    const sched = scheduler();
    sched.start();

    expect(sched.catchUp()).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired.length).toBe(1);
    sched.stop();
  });

  it("runs it once however many were missed", async () => {
    // Ten days offline should produce today's nudge, not ten of them.
    hourly(10 * 24 * 60 * 60_000);
    const sched = scheduler();
    sched.start();

    sched.catchUp();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired.length).toBe(1);
    sched.stop();
  });

  it("leaves a job alone when it ran within the period", async () => {
    /*
     * Marked as having just run, rather than a fixed minute ago.
     *
     * Against an hourly schedule, "a minute ago" is only inside the period
     * when the clock is more than a minute past the hour. Run at HH:00:30 the
     * top of the hour is more recent than the run, so catchUp fired and was
     * right to. The test failed in CI at exactly 07:00:00.
     */
    hourly(0);
    const sched = scheduler();
    sched.start();

    expect(sched.catchUp()).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toEqual([]);
    sched.stop();
  });

  it("does not fire a job that has never run", async () => {
    // Never run is not missed: a job created while the host was down starts
    // at its next proper time, not the moment it is noticed.
    store.create({
      name: "fresh",
      schedule: "0 * * * *",
      type: "actions",
      actions: [{ tool: "notify", args: {} }],
      enabled: true,
    });
    const sched = scheduler();
    sched.start();

    expect(sched.catchUp()).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toEqual([]);
    sched.stop();
  });

  it("records when a job actually ran", async () => {
    // Without this a missed run cannot be told from a recent one, which is
    // what the schedule page was getting wrong.
    const created = store.create({
      name: "j",
      schedule: "0 * * * *",
      type: "actions",
      actions: [{ tool: "notify", args: {} }],
      enabled: true,
    });
    expect(store.get(created.id)?.lastRunAt ?? null).toBeNull();

    await scheduler().fire(store.get(created.id)!);
    expect(store.get(created.id)?.lastRunAt).toBeGreaterThan(0);
  });
});
