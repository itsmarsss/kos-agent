import { describe, expect, it } from "vitest";

import { openDatabase } from "../store/db.js";
import { HealthMonitor } from "./health.js";
import { RunsLog } from "./runs.js";

function monitor(): { health: HealthMonitor; runs: RunsLog; tick: () => void } {
  const db = openDatabase(":memory:");
  let now = 1_000_000;
  const clock = (): number => now;
  return {
    health: new HealthMonitor(db, clock),
    runs: new RunsLog(db, clock),
    tick: () => {
      now += 60_000;
    },
  };
}

describe("HealthMonitor notices", () => {
  it("speaks up the first time something fails", () => {
    const { health } = monitor();
    const notice = health.observe("cron:7", "nightly digest", false, "boom");
    expect(notice?.kind).toBe("failing");
    expect(notice?.text).toContain("nightly digest");
    expect(notice?.text).toContain("boom");
  });

  it("stays quiet while a job keeps failing the same way", () => {
    const { health } = monitor();
    health.observe("cron:7", "nightly digest", false, "boom");
    // A job on a one-minute schedule would otherwise send 1440 of these a day.
    // 3 is an escalation point, so the run of quiet ones is 4 through 9.
    health.observe("cron:7", "nightly digest", false, "boom"); // 2
    health.observe("cron:7", "nightly digest", false, "boom"); // 3, speaks
    const quiet = [4, 5, 6, 7, 8, 9].map(() =>
      health.observe("cron:7", "nightly digest", false, "boom"),
    );
    expect(quiet.every((n) => n === null)).toBe(true);
  });

  it("speaks again at the escalation points, not on every failure", () => {
    const { health } = monitor();
    const spoke: number[] = [];
    for (let i = 1; i <= 40; i++) {
      const n = health.observe("cron:7", "nightly digest", false, "boom");
      if (n) spoke.push(i);
    }
    expect(spoke).toEqual([1, 3, 10, 30]);
  });

  it("says so when the job comes back", () => {
    const { health } = monitor();
    health.observe("cron:7", "nightly digest", false, "boom");
    const notice = health.observe("cron:7", "nightly digest", true, null);
    expect(notice?.kind).toBe("recovered");
    expect(notice?.text).toContain("nightly digest");
  });

  it("does not announce a recovery it never reported broken", () => {
    const { health } = monitor();
    expect(health.observe("cron:7", "nightly digest", true, null)).toBeNull();
  });

  it("treats a different error as worth saying even mid-streak", () => {
    const { health } = monitor();
    health.observe("cron:7", "digest", false, "disk full");
    const changed = health.observe("cron:7", "digest", false, "no such table");
    // The owner acted on the first message; the failure is now a different
    // one, and reporting it as more of the same would be wrong.
    expect(changed?.kind).toBe("failing");
    expect(changed?.text).toContain("no such table");
  });

  it("keeps its record across a restart", () => {
    const db = openDatabase(":memory:");
    const first = new HealthMonitor(db);
    first.observe("cron:7", "digest", false, "boom");
    // A restart used to forget, so a host that crash-looped re-sent the same
    // first-failure message on every boot.
    const second = new HealthMonitor(db);
    expect(second.observe("cron:7", "digest", false, "boom")).toBeNull();
  });

  it("tracks each job separately", () => {
    const { health } = monitor();
    health.observe("cron:7", "digest", false, "boom");
    expect(health.observe("cron:8", "backup", false, "boom")?.kind).toBe(
      "failing",
    );
  });
});

describe("HealthMonitor report", () => {
  it("is well when nothing has run", () => {
    const { health } = monitor();
    const report = health.report();
    expect(report.ok).toBe(true);
    expect(report.failing).toEqual([]);
    expect(report.recent.total).toBe(0);
  });

  it("counts the failure rate over recent runs", () => {
    const { health, runs, tick } = monitor();
    for (let i = 0; i < 8; i++) {
      runs.finish(runs.start("cron", "1"), "ok");
      tick();
    }
    for (let i = 0; i < 2; i++) {
      runs.finish(runs.start("cron", "1"), "error", "boom");
      tick();
    }
    const report = health.report();
    expect(report.recent.total).toBe(10);
    expect(report.recent.errors).toBe(2);
    expect(report.recent.rate).toBeCloseTo(0.2);
  });

  it("does not count skipped runs as failures", () => {
    const { health, runs } = monitor();
    runs.finish(runs.start("cron", "1"), "skipped");
    expect(health.report().recent.errors).toBe(0);
    expect(health.report().ok).toBe(true);
  });

  it("lists what is currently broken, with how long and how often", () => {
    const { health, tick } = monitor();
    health.observe("cron:7", "nightly digest", false, "boom");
    tick();
    tick();
    health.observe("cron:7", "nightly digest", false, "boom");
    const report = health.report();
    expect(report.ok).toBe(false);
    expect(report.failing).toHaveLength(1);
    expect(report.failing[0]).toMatchObject({
      key: "cron:7",
      label: "nightly digest",
      streak: 2,
      error: "boom",
    });
    expect(report.failing[0]!.since).toBe(1_000_000);
  });

  it("drops a job from the list once it recovers", () => {
    const { health } = monitor();
    health.observe("cron:7", "digest", false, "boom");
    health.observe("cron:7", "digest", true, null);
    expect(health.report().failing).toEqual([]);
    expect(health.report().ok).toBe(true);
  });
});
