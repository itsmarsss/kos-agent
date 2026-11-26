import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Workspace } from "../store/workspace.js";
import { CronScheduler, type KillSwitch, type SchedulerOptions } from "./scheduler.js";
import { shortestGap } from "./occurrence.js";
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
    agent: null,
    toolAllow: null,
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
    vi.useRealTimers();
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

  it("never runs a job twice at once, whichever path fires it, and runs it again once done", async () => {
    let release: () => void = () => undefined;
    let runs = 0;
    const sched = new CronScheduler(store, () => {
      runs += 1;
      return new Promise((r) => {
        release = () => r("ok");
      });
    });
    const slow = job({ id: 3, name: "slow" });
    const first = sched.fire(slow);
    // A second fire while the first is in flight: the tick and Run now share this.
    expect(await sched.fire(slow)).toEqual({ fired: false, reason: "error", error: "slow is already running" });
    expect(runs).toBe(1);
    release();
    expect(await first).toEqual({ fired: true, result: "ok" });
    // Another job is not held up by it, and the same job runs again once it is done.
    const again = sched.fire(slow);
    release();
    expect(await again).toEqual({ fired: true, result: "ok" });
    expect(runs).toBe(2);
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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-25T14:20:00Z"));
    const hourly = store.create({ name: "hourly", schedule: "0 * * * *", type: "actions" });
    const sched = new CronScheduler(store, async () => undefined);
    sched.start();
    const runs = sched.nextRuns(hourly.id, 2);
    expect(runs).toHaveLength(2);
    expect(runs[0]!).toBe(Date.parse("2026-11-25T15:00:00Z"));
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
    // Date, node-cron's own clock and its timers, at a fixed instant: no real tick, no minute rolling over mid-test.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const MINUTE_MS = 60_000;
  const HOUR_MS = 3_600_000;
  const DAY_MS = 24 * HOUR_MS;
  /** Now, on the minute and clear of every tick these jobs have: late is exactly what a test says, to the second. */
  const NOW = Date.parse("2026-11-25T14:20:00Z");

  function scheduler(options: SchedulerOptions = {}): CronScheduler {
    return new CronScheduler(
      store,
      async (j) => {
        fired.push(j.id);
      },
      { timezone: () => "UTC", catchUpGapMs: 0, clock: () => NOW, ...options },
    );
  }

  /** A daily job whose time came round `lateMs` before now, last run `ranBeforeMs` before that. */
  function daily(lateMs: number, ranBeforeMs = DAY_MS - HOUR_MS): number {
    const due = new Date(NOW - lateMs);
    const created = store.create({
      name: "daily",
      schedule: `${due.getUTCMinutes()} ${due.getUTCHours()} * * *`,
      type: "actions",
      actions: [{ tool: "notify", args: {} }],
      enabled: true,
    });
    store.markRun(created.id, due.getTime() - ranBeforeMs);
    return created.id;
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
    store.markRun(created.id, NOW - agoMs);
    return created.id;
  }

  /** How a skipped run's next time reads, in UTC as the scheduler here reads schedules. */
  function nextWords(sched: CronScheduler, id: number): string {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(sched.nextRuns(id, 1)[0]);
  }

  it("runs a job whose moment passed while the host was down", async () => {
    /*
     * The scheduler lives in the process, so a laptop closed at noon simply
     * does not run the noon job, and nothing says so. Seen for real: the
     * nightly backup had run every night since July while the 9am and noon
     * jobs had not fired once in two days.
     */
    daily(HOUR_MS);
    const sched = scheduler();
    sched.start();

    expect(sched.catchUp()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(fired.length).toBe(1);
    sched.stop();
  });

  it("runs missed jobs one after another, not all at once", async () => {
    // Fired together after a restart, they spent the provider's minute of tokens and failed.
    daily(HOUR_MS);
    daily(HOUR_MS);
    let finish: (() => void) | undefined;
    const running: number[] = [];
    const sched = new CronScheduler(
      store,
      (j) => {
        running.push(j.id);
        return new Promise<void>((resolve) => (finish = resolve));
      },
      { timezone: () => "UTC", catchUpGapMs: 0 },
    );
    sched.start();
    expect(sched.catchUp()).toBe(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(running).toHaveLength(1);
    finish!();
    await vi.advanceTimersByTimeAsync(20);
    expect(running).toHaveLength(2);
    finish!();
    sched.stop();
  });

  it("runs it once however many were missed", async () => {
    // Ten days offline should produce today's nudge, not ten of them.
    daily(HOUR_MS, 10 * DAY_MS);
    const sched = scheduler();
    sched.start();

    expect(sched.catchUp()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(fired.length).toBe(1);
    sched.stop();
  });

  it("leaves a job alone when it ran on time", async () => {
    // Marked as run just after its time, rather than a fixed minute ago, which
    // fell either side of the schedule depending on when the test ran.
    daily(HOUR_MS, -1_000);
    const sched = scheduler();
    sched.start();

    expect(sched.catchUp()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(fired).toEqual([]);
    sched.stop();
  });

  it("runs a missed run that is within the limit", async () => {
    daily(2 * HOUR_MS);
    const skipped: string[] = [];
    const sched = scheduler({ onSkip: (_j, _at, why) => skipped.push(why) });
    sched.start();

    expect(sched.catchUp()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(fired).toHaveLength(1);
    expect(skipped).toEqual([]);
    sched.stop();
  });

  it("skips a missed run more than the limit late, saying by how much and when the next is", async () => {
    // The kickoff caught up at midnight, nine hours before the real one.
    const id = daily(4 * HOUR_MS);
    const skipped: { id: number; at: number; why: string }[] = [];
    const sched = scheduler({ onSkip: (j, at, why) => skipped.push({ id: j.id, at, why }) });
    sched.start();

    expect(sched.catchUp()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(fired).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe(id);
    expect(NOW - skipped[0]!.at).toBe(4 * HOUR_MS);
    expect(skipped[0]!.why).toBe(`missed by 4h; next run at ${nextWords(sched, id)}`);
    sched.stop();
  });

  it("says a run just past the limit is over it, never a whole number that reads as within it", () => {
    const id = daily(3 * HOUR_MS);
    const skipped: string[] = [];
    const sched = scheduler({ clock: () => NOW + 30_000, onSkip: (_j, _at, why) => skipped.push(why) });
    sched.start();

    expect(sched.catchUp()).toBe(0);
    expect(skipped).toEqual([`missed by over 3h; next run at ${nextWords(sched, id)}`]);
    sched.stop();
  });

  it("runs a run exactly at the limit", () => {
    daily(3 * HOUR_MS);
    const sched = scheduler();
    sched.start();

    expect(sched.catchUp()).toBe(1);
    sched.stop();
  });

  it("reads the limit from the owner's setting", async () => {
    daily(4 * HOUR_MS);
    const sched = scheduler({ catchUpLimitHours: () => 6 });
    sched.start();

    expect(sched.catchUp()).toBe(1);
    sched.stop();
  });

  it("never catches up at a limit of 0, however little was missed", async () => {
    const id = daily(10 * MINUTE_MS);
    const skipped: string[] = [];
    const sched = scheduler({ catchUpLimitHours: () => 0, onSkip: (_j, _at, why) => skipped.push(why) });
    sched.start();

    expect(sched.catchUp()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(fired).toEqual([]);
    expect(skipped).toEqual([`missed by 10m; next run at ${nextWords(sched, id)}`]);
    sched.stop();
  });

  it("never catches up a job that runs hourly or more often, and notes nothing", async () => {
    // Its next tick is as good as a late run.
    hourly(5 * HOUR_MS);
    const often = store.create({ name: "often", schedule: "*/15 * * * *", type: "actions", enabled: true });
    store.markRun(often.id, NOW - 2 * HOUR_MS);
    const skipped: string[] = [];
    const sched = scheduler({ onSkip: (_j, _at, why) => skipped.push(why) });
    sched.start();

    expect(sched.catchUp()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(fired).toEqual([]);
    expect(skipped).toEqual([]);
    sched.stop();
  });

  it("fires the job as it is when its turn comes, and not at all once its own tick ran it or it was turned off", async () => {
    const first = daily(HOUR_MS);
    const ranMeanwhile = daily(HOUR_MS);
    const turnedOff = daily(HOUR_MS);
    let finish: (() => void) | undefined;
    const running: number[] = [];
    const sched = new CronScheduler(
      store,
      (j) => {
        running.push(j.id);
        return new Promise<void>((resolve) => (finish = resolve));
      },
      { timezone: () => "UTC", catchUpGapMs: 0, clock: () => NOW },
    );
    sched.start();
    expect(sched.catchUp()).toBe(3);
    await vi.advanceTimersByTimeAsync(20);
    expect(running).toEqual([first]);
    // While the first runs, the second's own tick runs it and the third is turned off.
    store.markRun(ranMeanwhile, Date.now());
    store.setEnabled(turnedOff, false);
    finish!();
    await vi.advanceTimersByTimeAsync(20);
    expect(running).toEqual([first]);
    sched.stop();
  });

  describe("after a sleep", () => {
    /**
     * Asleep through a job's time, node-cron wakes more than a second late,
     * does not run the tick, and says it missed it. The scheduler takes that
     * as a restart for the job: run within the limit, skipped past it.
     */
    async function wake(lateMs: number, lastRunAt: number | null): Promise<{ id: number; skipped: string[]; sched: CronScheduler }> {
      vi.setSystemTime(Date.parse("2026-11-25T08:59:30Z"));
      const created = store.create({ name: "kickoff", schedule: "0 9 * * *", type: "actions", enabled: true });
      if (lastRunAt !== null) store.markRun(created.id, lastRunAt);
      const skipped: string[] = [];
      const sched = new CronScheduler(store, async (j) => void fired.push(j.id), {
        timezone: () => "UTC",
        catchUpGapMs: 0,
        onSkip: (_j, _at, why) => skipped.push(why),
      });
      sched.start();
      // The lid closes before 9:00 and opens lateMs after it.
      vi.setSystemTime(Date.parse("2026-11-25T09:00:00Z") + lateMs - 30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(10);
      return { id: created.id, skipped, sched };
    }

    it("runs the missed run once when it wakes within the limit", async () => {
      const { sched, skipped } = await wake(2 * HOUR_MS, Date.parse("2026-11-24T09:00:05Z"));
      expect(fired).toHaveLength(1);
      expect(skipped).toEqual([]);
      sched.stop();
    });

    it("skips it, saying so, when it wakes past the limit", async () => {
      const { sched, skipped } = await wake(4 * HOUR_MS, Date.parse("2026-11-24T09:00:05Z"));
      expect(fired).toEqual([]);
      expect(skipped).toEqual(["missed by 4h; next run at Thu, Nov 26, 9:00 AM"]);
      sched.stop();
    });

    it("counts a job that never ran from the tick it missed, since it was held then", async () => {
      const { sched } = await wake(HOUR_MS, null);
      expect(fired).toHaveLength(1);
      sched.stop();
    });
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
    await vi.advanceTimersByTimeAsync(20);
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

/**
 * Missed is a run the schedule really had between the last run and now, in
 * the profile's timezone. Worked out from the gap between the next two runs,
 * a schedule that is not evenly spaced (twice a day, weekdays) fired at boot
 * with nothing missed, and a job ran at the host's 9am, not the owner's.
 */
describe("what a schedule really missed, in the profile's timezone", () => {
  let root: string;
  let ws: Workspace;
  let store: CronStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-missed-"));
    ws = Workspace.open(root);
    store = new CronStore(ws.db);
    // node-cron reads a schedule's next runs off the real clock: each case sets it to its own now.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-25T14:20:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** How many missed runs catchUp finds for a job on `schedule` last run at `ranAt`, checked at `now`: run or skipped. */
  function missed(schedule: string, ranAt: string, now: string, timezone = "UTC"): number {
    const created = store.create({ name: "j", schedule, type: "actions", actions: [{ tool: "notify", args: {} }], enabled: true });
    store.markRun(created.id, Date.parse(ranAt));
    vi.setSystemTime(Date.parse(now));
    let skipped = 0;
    const sched = new CronScheduler(store, async () => undefined, {
      timezone: () => timezone,
      catchUpGapMs: 0,
      onSkip: () => (skipped += 1),
    });
    sched.start();
    try {
      return sched.catchUp() + skipped;
    } finally {
      sched.stop();
      store.delete(created.id);
    }
  }

  /** What catchUp does for a job on `schedule` last run at `ranAt`, checked at `now`, under a 3-hour limit unless given. */
  function caught(schedule: string, ranAt: string, now: string, timezone = "UTC", limit = 3): "ran" | "skipped" | "nothing" {
    const created = store.create({ name: "j", schedule, type: "actions", enabled: true });
    store.markRun(created.id, Date.parse(ranAt));
    vi.setSystemTime(Date.parse(now));
    let skipped = false;
    const sched = new CronScheduler(store, async () => undefined, {
      timezone: () => timezone,
      catchUpGapMs: 0,
      catchUpLimitHours: () => limit,
      onSkip: () => (skipped = true),
    });
    sched.start();
    try {
      return sched.catchUp() > 0 ? "ran" : skipped ? "skipped" : "nothing";
    } finally {
      sched.stop();
      store.delete(created.id);
    }
  }

  it("leaves a missed run to a next run under an hour away, and catches up the rest within the limit", () => {
    // Every two hours: booted at 11:59, the 12:00 run is a minute off, so 10:00 is not caught up just before it.
    expect(caught("0 */2 * * *", "2026-11-19T08:00:30Z", "2026-11-19T11:59:00Z")).toBe("nothing");
    expect(caught("0 */2 * * *", "2026-11-19T08:00:30Z", "2026-11-19T10:30:00Z")).toBe("ran");
    // Missed 10:00, next 9:00 tomorrow: caught up. Missed 9:00 with 10:00 half an hour off: left to 10:00.
    expect(caught("0 9,10 * * *", "2026-11-19T09:00:30Z", "2026-11-19T10:30:00Z")).toBe("ran");
    expect(caught("0 9,10 * * *", "2026-11-18T10:00:30Z", "2026-11-19T09:30:00Z")).toBe("nothing");
    // The last of the working day, with tomorrow's 8:00 far off: caught up.
    expect(caught("0 8-17 * * *", "2026-11-19T16:00:30Z", "2026-11-19T17:30:00Z")).toBe("ran");
    // Hourly and quarter-hourly always have their next run within the hour.
    expect(caught("0 * * * *", "2026-11-19T05:00:30Z", "2026-11-19T08:20:00Z")).toBe("nothing");
    expect(caught("*/15 * * * *", "2026-11-19T07:00:30Z", "2026-11-19T08:20:00Z")).toBe("nothing");
  });

  it("runs a run under a minute late as on time, whatever the limit: a stall, not a miss", () => {
    expect(caught("0 9 * * *", "2026-11-18T09:00:05Z", "2026-11-19T09:00:02Z", "UTC", 0)).toBe("ran");
    expect(caught("0 * * * *", "2026-11-19T08:00:05Z", "2026-11-19T09:00:02Z")).toBe("ran");
    expect(caught("0 9 * * *", "2026-11-18T09:00:05Z", "2026-11-19T09:01:00Z", "UTC", 0)).toBe("skipped");
  });

  it("does not take a spring change for an hourly schedule", () => {
    // Toronto skips 2:00 to 3:00 on 8 March 2026, so 1:00 and 3:00 are an hour apart that night; the job is still two-hourly.
    expect(caught("0 1,3 * * *", "2026-03-08T06:00:30Z", "2026-03-08T08:00:00Z", "America/Toronto")).toBe("ran");
    expect(shortestGap([Date.parse("2026-03-08T06:00:00Z"), Date.parse("2026-03-08T07:00:00Z")], "America/Toronto")).toBe(2 * 3_600_000);
    // The autumn change repeats 1:30: one run, not a gap of nothing.
    expect(shortestGap([Date.parse("2026-11-01T05:30:00Z"), Date.parse("2026-11-01T06:30:00Z"), Date.parse("2026-11-02T06:30:00Z")], "America/Toronto")).toBe(24 * 3_600_000);
  });

  it("misses nothing at the 2:30 Toronto's spring change skips, and catches up the next real one", () => {
    expect(caught("30 2 * * *", "2026-03-07T07:30:05Z", "2026-03-08T12:00:00Z", "America/Toronto")).toBe("nothing");
    expect(caught("30 2 * * *", "2026-03-07T07:30:05Z", "2026-03-09T07:00:00Z", "America/Toronto")).toBe("ran");
  });

  it("always catches up a job that runs less often than daily, however late", () => {
    // Monthly, missed by twenty days.
    expect(caught("0 0 1 * *", "2026-10-01T00:00:05Z", "2026-11-21T00:00:00Z")).toBe("ran");
    // Yearly, missed by months.
    expect(caught("0 0 1 1 *", "2025-01-01T00:00:05Z", "2026-05-01T00:00:00Z")).toBe("ran");
    // Weekly, missed by two days.
    expect(caught("0 9 * * 1", "2026-11-09T09:00:05Z", "2026-11-18T09:00:00Z")).toBe("ran");
    // Daily is held to the limit; weekdays too.
    expect(caught("0 9 * * *", "2026-11-17T09:00:05Z", "2026-11-18T13:00:00Z")).toBe("skipped");
    expect(caught("0 9 * * 1-5", "2026-11-16T09:00:05Z", "2026-11-17T13:00:00Z")).toBe("skipped");
    // Never is never, monthly or not.
    expect(caught("0 0 1 * *", "2026-10-01T00:00:05Z", "2026-11-01T00:10:00Z", "UTC", 0)).toBe("skipped");
  });

  it("fires nothing for an uneven schedule that missed nothing", () => {
    // Twice a day, checked at 05:04: the last run was 17:00 yesterday, and nothing came round since.
    expect(missed("0 9,17 * * *", "2026-11-18T17:00:30Z", "2026-11-19T05:04:00Z")).toBe(0);
    // A weekday job on a Saturday: Friday's run was the last one due.
    expect(missed("0 9 * * 1-5", "2026-11-20T09:00:10Z", "2026-11-21T10:00:00Z")).toBe(0);
  });

  it("fires once for an uneven schedule that did miss a run", () => {
    expect(missed("0 9,17 * * *", "2026-11-18T09:00:30Z", "2026-11-19T05:04:00Z")).toBe(1);
    // Thursday's ran, Friday's did not.
    expect(missed("0 9 * * 1-5", "2026-11-19T09:00:10Z", "2026-11-21T10:00:00Z")).toBe(1);
  });

  it("counts the owner's 9am, across the spring change", () => {
    // Los Angeles springs forward on 8 March 2026. Saturday's 9am PST ran; Sunday's 9am PDT is 16:00Z.
    expect(missed("0 9 * * *", "2026-03-07T17:00:05Z", "2026-03-08T15:30:00Z", "America/Los_Angeles")).toBe(0);
    expect(missed("0 9 * * *", "2026-03-07T17:00:05Z", "2026-03-08T16:30:00Z", "America/Los_Angeles")).toBe(1);
  });

  it("counts the owner's 9am, across the autumn change", () => {
    // Falls back on 1 November 2026: 24.5 hours after Saturday's 9am PDT it is only 8:30 PST, so nothing is missed yet.
    expect(missed("0 9 * * *", "2026-10-31T16:00:05Z", "2026-11-01T16:30:00Z", "America/Los_Angeles")).toBe(0);
    expect(missed("0 9 * * *", "2026-10-31T16:00:05Z", "2026-11-01T17:30:00Z", "America/Los_Angeles")).toBe(1);
  });

  it("misses nothing at a time the spring change skips, and the next real one counts", () => {
    // 02:30 does not happen in Los Angeles on 8 March 2026: the clocks go from 02:00 to 03:00.
    expect(missed("30 2 * * *", "2026-03-07T10:30:05Z", "2026-03-08T19:00:00Z", "America/Los_Angeles")).toBe(0);
    expect(missed("30 2 * * *", "2026-03-07T10:30:05Z", "2026-03-09T19:00:00Z", "America/Los_Angeles")).toBe(1);
  });

  it("counts a time the autumn change repeats once, so it is not caught up twice", () => {
    // 01:30 happens twice on 1 November 2026: 08:30Z in PDT, then 09:30Z in PST. The first ran.
    expect(missed("30 1 * * *", "2026-11-01T08:30:05Z", "2026-11-01T09:45:00Z", "America/Los_Angeles")).toBe(0);
    // Down through both, it is one missed run, not two.
    expect(missed("30 1 * * *", "2026-10-31T08:30:05Z", "2026-11-01T09:45:00Z", "America/Los_Angeles")).toBe(1);
  });

  it("schedules a job at the profile's hour, not the host's", () => {
    const created = store.create({ name: "j", schedule: "0 9 * * *", type: "actions", enabled: true });
    const sched = new CronScheduler(store, async () => undefined, { timezone: () => "Asia/Kolkata" });
    sched.start();
    try {
      const local = (at: number): string => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
      expect(sched.nextRuns(created.id, 2).map(local)).toEqual(["09:00", "09:00"]);
    } finally {
      sched.stop();
    }
  });
});
