import cron, { type ScheduledTask } from "node-cron";

import type { CronStore } from "./store.js";
import type { CronJob } from "./types.js";

/** Shared halt flag. When halted, no cron or self-prompt fires. */
export interface KillSwitch {
  halted: boolean;
}

/** Runs a fired job (typically wraps runCronJob with its deps). */
export type CronRunner = (job: CronJob) => Promise<unknown>;

export interface SchedulerOptions {
  killSwitch?: KillSwitch;
  /**
   * Hard cap on self_prompt fires per rolling hour (runaway-loop guard).
   * A function so the owner changing it takes effect on the next fire rather
   * than on the next restart.
   */
  maxSelfPromptsPerHour?: number | (() => number);
  clock?: () => number;
}

export type FireOutcome =
  | { fired: true; result: unknown }
  | { fired: false; reason: "halted" | "rate_limited" | "error"; error?: string };

const DEFAULT_MAX_SELF_PROMPTS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

/**
 * In-process cron scheduler over the crons table. Registers node-cron tasks for
 * enabled jobs; each tick calls fire(), which enforces the kill switch and the
 * self-prompt rate limit before running the job. Jobs are data, so reload()
 * re-reads the store after changes.
 */
export class CronScheduler {
  private readonly tasks = new Map<number, ScheduledTask>();
  private selfPromptFires: number[] = [];

  constructor(
    private readonly store: CronStore,
    private readonly run: CronRunner,
    private readonly options: SchedulerOptions = {},
  ) {}

  start(): void {
    this.stop();
    for (const job of this.store.list(true)) {
      if (!cron.validate(job.schedule)) continue;
      const task = cron.schedule(job.schedule, () => {
        void this.fire(job);
      });
      this.tasks.set(job.id, task);
    }
  }

  /**
   * Run what was due while nothing was listening.
   *
   * This scheduler lives in the process, so a job whose moment passes while
   * the host is down does not happen and nothing says so. On a laptop that is
   * most of them: on the machine this was written against, the nightly backup
   * had run every night since July while the 9am and noon jobs had not fired
   * once in two days, because nothing was running at 9am or noon.
   *
   * At most one run per job, however many were missed. Ten days offline
   * should produce today's nudge, not ten of them.
   */
  catchUp(): number {
    let ran = 0;
    for (const [id, task] of this.tasks) {
      const job = this.store.get(id);
      if (!job?.enabled) continue;
      // Never run is not missed: a job created while the host was down should
      // start at its next proper time, not the moment it is noticed.
      if (!job.lastRunAt) continue;
      const due = this.previousOccurrence(task);
      if (due === null || due <= job.lastRunAt) continue;
      ran += 1;
      void this.fire(job);
    }
    return ran;
  }

  /**
   * When this schedule last came round, worked out from when it next will.
   *
   * node-cron will say when a task runs next but not when it last should
   * have, so the gap between the next two is used as the period and stepped
   * back once. Exact for the fixed intervals a schedule usually is, and close
   * enough for the rest: being an hour out decides nothing, since the
   * question is only whether a run was skipped entirely.
   */
  private previousOccurrence(task: ScheduledTask): number | null {
    const upcoming = task.getNextRuns(2);
    if (upcoming.length < 2) return null;
    const period = upcoming[1]!.getTime() - upcoming[0]!.getTime();
    if (period <= 0) return null;
    return upcoming[0]!.getTime() - period;
  }

  stop(): void {
    for (const task of this.tasks.values()) void task.destroy();
    this.tasks.clear();
  }

  reload(): void {
    this.start();
  }

  scheduledCount(): number {
    return this.tasks.size;
  }

  /** Run a job now, applying the kill switch and rate-limit guards. */
  async fire(job: CronJob): Promise<FireOutcome> {
    if (this.options.killSwitch?.halted) {
      return { fired: false, reason: "halted" };
    }
    if (job.type === "self_prompt" && this.rateLimited()) {
      return { fired: false, reason: "rate_limited" };
    }
    try {
      if (job.type === "self_prompt") this.selfPromptFires.push(this.now());
      const result = await this.run(job);
      // Recorded on the way out, so a missed run is detectable next boot.
      this.store.markRun(job.id, this.now());
      return { fired: true, result };
    } catch (err) {
      return {
        fired: false,
        reason: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private rateLimited(): boolean {
    const configured = this.options.maxSelfPromptsPerHour;
    const max =
      (typeof configured === "function" ? configured() : configured) ??
      DEFAULT_MAX_SELF_PROMPTS_PER_HOUR;
    const cutoff = this.now() - HOUR_MS;
    this.selfPromptFires = this.selfPromptFires.filter((t) => t >= cutoff);
    return this.selfPromptFires.length >= max;
  }

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }
}
