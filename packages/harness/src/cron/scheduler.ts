import cron, { type ScheduledTask } from "node-cron";

import { lastOccurrence, shortestGap } from "./occurrence.js";
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
   * Hours late a missed run may still run after a restart or a sleep; later
   * than this it is skipped. Zero never catches up. Read at each catch-up.
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
const DAY_MS = 24 * HOUR_MS;
/** Runs looked ahead at to read a schedule's period. */
const PERIOD_RUNS = 5;

/**
 * How late a missed run is, as the skip reason says it, rounded down and
 * "over" when there is more: 3h and 30s late reads "over 3h", never "3h",
 * which would look like it should have run under a 3-hour limit.
 */
function lateWords(ms: number): string {
  // To the second: a wake a few milliseconds after a whole hour is not "over" it.
  const late = Math.floor(ms / 1000) * 1000;
  const [unit, size] = late < HOUR_MS ? ["m", MINUTE_MS] : ["h", HOUR_MS];
  const whole = Math.floor(late / size);
  if (whole === 0) return "under 1m";
  return `${late % size > 0 ? "over " : ""}${whole}${unit}`;
}

/** Why a missed run was skipped: "missed by over 4h; next run at Wed, Nov 26, 9:00 AM". */
function skipReason(lateMs: number, nextAt: number | undefined, timezone: string | undefined): string {
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
      // A tick that came too late to run: the machine slept through it.
      task.on("execution:missed", (context) => this.missedTick(job.id, context.date.getTime()));
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
   * once in two days, because nothing was running at 9am or noon. Called at
   * boot; a sleep comes in through missedTick.
   *
   * At most one run per job, however many were missed. Ten days offline
   * should produce today's nudge, not ten of them.
   *
   * One after another, a few seconds apart: fired together after a restart,
   * a day's missed runs spent the provider's minute of tokens at once and
   * failed on its rate limit, and failed again after the next restart, since
   * a failed run is not marked as run.
   */
  catchUp(): number {
    let ran = 0;
    for (const id of this.tasks.keys()) if (this.catchUpJob(id)) ran += 1;
    return ran;
  }

  /** Jobs with a missed tick waiting to be looked at, so one wake's many missed slots are one look. */
  private readonly missedTicks = new Set<number>();

  /**
   * A tick node-cron would not run because it came more than a second late,
   * which is what a sleep through a job's time looks like: it says so and
   * moves on to the next. Treated as a restart is, for that job. A job that
   * has never run counts from the tick it missed, since it was held then.
   */
  private missedTick(id: number, slot: number): void {
    if (this.missedTicks.has(id)) return;
    this.missedTicks.add(id);
    setTimeout(() => {
      this.missedTicks.delete(id);
      if (this.tasks.has(id)) this.catchUpJob(id, slot - 1);
    }, 0);
  }

  /** Jobs whose catch-up run is queued and not yet done. */
  private readonly queued = new Set<number>();

  /**
   * Catch one job up, or skip it: true when a run was queued.
   *
   * Under a minute late is on time, whatever the limit: a stalled event
   * loop, not a missed run. Otherwise, a job whose next run is under an hour
   * away waits for it: its next tick is as good as a late one, and a
   * catch-up just before it would run the job twice in a row. That covers
   * every job that runs hourly or more often.
   *
   * Not any run, however late: the morning kickoff caught up at midnight
   * reads as noise, and the real one follows nine hours later. A run more
   * than the catch-up limit late is skipped, said so in Runs only, and the
   * next one runs on time. One that runs less often than daily always
   * catches up, however late: next month's run is no substitute for this
   * month's. Zero, the owner's "never", holds for all.
   */
  private catchUpJob(id: number, since?: number): boolean {
    const task = this.tasks.get(id);
    const job = this.store.get(id);
    if (!task || !job?.enabled || this.queued.has(id)) return false;
    // Never run is not missed: a job created while the host was down should
    // start at its next proper time, not the moment it is noticed.
    const after = job.lastRunAt ?? since;
    if (!after) return false;
    const timezone = this.timezone();
    const now = this.now();
    const missedAt = lastOccurrence(task, job.schedule, timezone, now, after);
    if (missedAt === null) return false;
    const late = now - missedAt;
    if (late >= MINUTE_MS) {
      const nextWithinTheHour = lastOccurrence(task, job.schedule, timezone, now + HOUR_MS - 1, now) !== null;
      if (nextWithinTheHour) return false;
      const limitMs = (this.options.catchUpLimitHours?.() ?? DEFAULT_CATCH_UP_LIMIT_HOURS) * HOUR_MS;
      const lessThanDaily = shortestGap(task.getNextRuns(PERIOD_RUNS).map((d) => d.getTime()), timezone) > DAY_MS;
      if (limitMs === 0 || (!lessThanDaily && late > limitMs)) {
        this.options.onSkip?.(job, missedAt, skipReason(late, task.getNextRuns(1)[0]?.getTime(), timezone));
        return false;
      }
    }
    this.queued.add(id);
    const gap = this.options.catchUpGapMs ?? DEFAULT_CATCH_UP_GAP_MS;
    this.catching = this.catching.then(async () => {
      // As it is now, not as it was when queued: turned off, or run by its own tick while this waited.
      const current = this.store.get(id);
      const due = current?.enabled === true && (current.lastRunAt ?? 0) < missedAt;
      if (due) await this.fire(current);
      this.queued.delete(id);
      if (due) await new Promise((resolve) => setTimeout(resolve, gap));
    });
    return true;
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
