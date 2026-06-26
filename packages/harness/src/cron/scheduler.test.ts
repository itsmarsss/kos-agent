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
});
