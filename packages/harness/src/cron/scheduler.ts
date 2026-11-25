import cron, { type ScheduledTask } from "node-cron";

import { lastOccurrence } from "./occurrence.js";
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
  /** The pause between one missed run and the next after a restart. */
  catchUpGapMs?: number;
  /**
   * Hours late a missed run may still run after a restart; later than this
   * it is skipped. Zero never catches up. Read at each catch-up.
   */
  catchUpLimitHours?: () => number;
  /** A missed run left for the next one: when it was due, and why it was left. */
  onSkip?: (job: CronJob, missedAt: number, reason: string) => void;
  /** The profile's timezone, which every schedule is read in: 9am is the owner's 9am, not the host's. */
  timezone?: () => string | undefined;
}

export type FireOutcome =
  | { fired: true; result: unknown }
  | { fired: false; reason: "halted" | "rate_limited" | "error"; error?: string };

const DEFAULT_MAX_SELF_PROMPTS_PER_HOUR = 10;
const DEFAULT_CATCH_UP_GAP_MS = 5_000;
const DEFAULT_CATCH_UP_LIMIT_HOURS = 3;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How late a missed run is, as the skip reason says it: minutes under an hour, hours after. */
function lateWords(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))}m`;
  const hours = ms / HOUR_MS;
  return hours < 10 ? `${Number(hours.toFixed(1))}h` : `${Math.round(hours)}h`;
}

/** Why a missed run was skipped: "missed by 4h; next run at Wed, Nov 26, 9:00 AM". */
export function skipReason(lateMs: number, nextAt: number | undefined, timezone: string | undefined): string {
  const missed = `missed by ${lateWords(lateMs)}`;
  if (nextAt === undefined) return missed;
  const when = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(nextAt);
  return `${missed}; next run at ${when}`;
}

/**
 * In-process cron scheduler over the crons table. Registers node-cron tasks for
 * enabled jobs; each tick calls fire(), which enforces the kill switch and the
 * self-prompt rate limit before running the job. Jobs are data, so reload()
 * re-reads the store after changes.
 */
export class CronScheduler {
  private readonly tasks = new Map<number, ScheduledTask>();
  private selfPromptFires: number[] = [];
  /** The missed runs queued after a restart, run one after another. */
  private catching: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: CronStore,
    private readonly run: CronRunner,
    private readonly options: SchedulerOptions = {},
  ) {}

  start(): void {
    this.stop();
    const timezone = this.timezone();
    for (const job of this.store.list(true)) {
      if (!cron.validate(job.schedule)) continue;
      const task = cron.schedule(
        job.schedule,
        () => {
          void this.fire(job);
        },
        timezone ? { timezone } : {},
      );
      this.tasks.set(job.id, task);
    }
  }

  /** The profile's timezone, when it is one this runtime knows; the host's otherwise. */
  private timezone(): string | undefined {
    const zone = this.options.timezone?.();
    if (!zone) return undefined;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return zone;
    } catch {
      return undefined;
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
   *
   * Not any run, however late: the morning kickoff caught up at midnight
   * reads as noise, and the real one follows nine hours later. A run more
   * than the catch-up limit late is skipped, said so in Runs only, and the
   * next one runs on time. A job that runs hourly or more often never
   * catches up: its next tick is as good as a late one.
   *
   * One after another, a few seconds apart: fired together after a restart,
   * a day's missed runs spent the provider's minute of tokens at once and
   * failed on its rate limit, and failed again after the next restart, since
   * a failed run is not marked as run.
   */
  catchUp(): number {
    let ran = 0;
    const timezone = this.timezone();
    const now = this.now();
    const limitMs = (this.options.catchUpLimitHours?.() ?? DEFAULT_CATCH_UP_LIMIT_HOURS) * HOUR_MS;
    for (const [id, task] of this.tasks) {
      const job = this.store.get(id);
      if (!job?.enabled) continue;
      // Never run is not missed: a job created while the host was down should
      // start at its next proper time, not the moment it is noticed.
      if (!job.lastRunAt) continue;
      const missedAt = lastOccurrence(task, job.schedule, timezone, now, job.lastRunAt);
      if (missedAt === null) continue;
      // Hourly or more often: it also came round in the hour before the run it missed.
      const hourlyOrMore = lastOccurrence(task, job.schedule, timezone, missedAt - 1, missedAt - HOUR_MS - 1) !== null;
      if (hourlyOrMore) continue;
      const late = now - missedAt;
      if (limitMs === 0 || late > limitMs) {
        this.options.onSkip?.(job, missedAt, skipReason(late, task.getNextRuns(1)[0]?.getTime(), timezone));
        continue;
      }
      ran += 1;
      const gap = this.options.catchUpGapMs ?? DEFAULT_CATCH_UP_GAP_MS;
      this.catching = this.catching
        .then(() => this.fire(job))
        .then(() => new Promise((resolve) => setTimeout(resolve, gap)));
    }
    return ran;
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

  /** When a scheduled job fires next, as epoch ms, soonest first. Empty for a job not held. */
  nextRuns(id: number, count: number): number[] {
    const task = this.tasks.get(id);
    if (!task) return [];
    return task.getNextRuns(count).map((d) => d.getTime());
  }

  /** Jobs running right now, by id, whichever path fired them. */
  private readonly firing = new Set<number>();

  /** Run a job now, applying the kill switch, the rate limit, and the one-at-a-time guard. */
  async fire(job: CronJob): Promise<FireOutcome> {
    if (this.options.killSwitch?.halted) {
      return { fired: false, reason: "halted" };
    }
    /*
     * A job never runs twice at once, whichever path fired it.
     *
     * This guard used to sit one level up, in the cron service, which Run
     * now goes through; the schedule's own tick calls this directly, so
     * pressing Run now during a scheduled run started a second run and sent
     * a second nudge. A self-prompt job that fires itself, or A firing B
     * firing A, stops here too, because the first is still in flight.
     */
    if (this.firing.has(job.id)) {
      return { fired: false, reason: "error", error: `${job.name} is already running` };
    }
    if (job.type === "self_prompt" && this.rateLimited()) {
      return { fired: false, reason: "rate_limited" };
    }
    this.firing.add(job.id);
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
    } finally {
      this.firing.delete(job.id);
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
