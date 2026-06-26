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
  /** Hard cap on self_prompt fires per rolling hour (runaway-loop guard). */
  maxSelfPromptsPerHour?: number;
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
    const max =
      this.options.maxSelfPromptsPerHour ?? DEFAULT_MAX_SELF_PROMPTS_PER_HOUR;
    const cutoff = this.now() - HOUR_MS;
    this.selfPromptFires = this.selfPromptFires.filter((t) => t >= cutoff);
    return this.selfPromptFires.length >= max;
  }

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }
}
