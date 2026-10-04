import { cronFailure, type CronExecResult } from "../cron/executor.js";
import { CronScheduler, type FireOutcome, type KillSwitch } from "../cron/scheduler.js";
import type { CronStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import type { RunStatus } from "../ops/runs.js";
import { cronSessionId } from "./session.js";

/**
 * Scheduled jobs, as the kernel sees them: when the scheduler runs, what
 * one run costs in bookkeeping, and what firing a job by hand means.
 *
 * The scheduler decides when; this decides what a run is: a run-log row,
 * a health verdict, the backup job that runs outside the tool path, and
 * the stop that keeps a job from firing while it is already firing. What
 * a run does inside its conversation stays with the kernel, which owns
 * threads and tools, and comes in as one closure.
 */

/** What running a job by hand produced, in terms the caller can report. */
export interface CronFireResult {
  outcome: FireOutcome;
  /** Fired and every action succeeded. */
  ok: boolean;
  error?: string;
}

export interface CronServiceDeps {
  crons: CronStore;
  killSwitch: KillSwitch;
  selfPromptsPerHour: () => number;
  /**
   * Run in a lane. A job runs in its own thread's lane, so two jobs run at
   * once and a job never waits on a chat, but a job cannot overlap a message
   * the owner sends to its thread.
   */
  enqueue: <T>(work: () => Promise<T>, lane: string) => Promise<T>;
  runs: {
    start: (kind: string, ref: string) => number;
    finish: (id: number, status: RunStatus, error?: string | null) => void;
  };
  health: { failing: () => { key: string }[]; forget: (key: string) => void };
  /** Tell the caretaker how the job did, so a failure is noticed and told. */
  report: (key: string, label: string, ok: boolean, error: string | null) => void;
  backup: { ensureRepo: () => Promise<void>; snapshot: (message: string) => Promise<unknown> };
  /** Run the job in its own thread with the guarded toolbox. The kernel's. */
  run: (job: CronJob) => Promise<CronExecResult>;
}

export const BACKUP_JOB = "kos.backup";

export class CronService {
  private scheduler?: CronScheduler;
  private readonly firing = new Set<number>();

  constructor(private readonly deps: CronServiceDeps) {}

  start(): void {
    this.scheduler = new CronScheduler(
      this.deps.crons,
      (job) => this.deps.enqueue(() => this.runLogged(job), cronSessionId(job.id)),
      {
        killSwitch: this.deps.killSwitch,
        maxSelfPromptsPerHour: () => this.deps.selfPromptsPerHour(),
      },
    );
    this.scheduler.start();
    // Also at boot, not only on reload: a job deleted while the host was down
    // would otherwise keep its failure on the health report until something
    // else happened to touch a schedule.
    this.pruneHealth();
  }

  stop(): void {
    this.scheduler?.stop();
    this.scheduler = undefined;
  }

  /**
   * Called after the schedule is registered, not inside start(), so a reload
   * after an edit does not re-fire anything: only a real boot catches up.
   */
  catchUp(): number {
    return this.scheduler?.catchUp() ?? 0;
  }

  reload(): void {
    this.scheduler?.reload();
    this.pruneHealth();
  }

  /** Jobs the running scheduler actually holds, as opposed to rows in the table. */
  scheduledCount(): number {
    return this.scheduler?.scheduledCount() ?? 0;
  }

  /**
   * Run one job now, through the same path the schedule uses.
   *
   * "Does this job actually work" was previously answerable only by waiting
   * for its schedule to come round, which for a nightly job means a day per
   * attempt. Going through the scheduler's fire means the kill switch, the
   * rate limit, the run log, and the health report all see it exactly as
   * they would at 3am.
   */
  async fire(id: number): Promise<CronFireResult> {
    const job = this.deps.crons.get(id);
    if (!job) throw new Error(`no such cron: ${id}`);
    if (!this.scheduler) this.start();
    /*
     * A job cannot fire while it is already firing.
     *
     * A self-prompt job whose prompt asks KOS to run a job can name itself,
     * and each run would start another before the first had finished. The
     * rate limit bounds how many self-prompts happen in an hour, which is a
     * cap on the damage rather than a stop; this is the stop. It also breaks
     * the longer loop, A firing B firing A, because A is still in flight.
     */
    if (this.firing.has(id)) {
      const outcome: FireOutcome = { fired: false, reason: "error", error: `${job.name} is already running` };
      return { outcome, ok: false, error: outcome.error! };
    }
    this.firing.add(id);
    try {
      const outcome = await this.scheduler!.fire(job);
      if (!outcome.fired) {
        return { outcome, ok: false, error: outcome.error ?? outcome.reason };
      }
      // "It fired" is not "it worked": a job every one of whose actions
      // errored fires perfectly well, and reporting that as a success is how
      // a broken job gets confirmed as healthy by the person checking it.
      const failure = cronFailure(outcome.result as CronExecResult);
      return failure ? { outcome, ok: false, error: failure } : { outcome, ok: true };
    } finally {
      this.firing.delete(id);
    }
  }

  /** One run, on the record: the run log and the health report both hear how it went. */
  private async runLogged(job: CronJob): Promise<CronExecResult> {
    const runId = this.deps.runs.start("cron", String(job.id));
    const key = `cron:${job.id}`;
    try {
      // The built-in workspace backup runs outside the tool path.
      if (job.name === BACKUP_JOB && job.type === "actions") {
        await this.deps.backup.ensureRepo();
        await this.deps.backup.snapshot("scheduled backup");
        this.deps.runs.finish(runId, "ok");
        this.deps.report(key, job.name, true, null);
        return { ran: true, type: "actions", results: [] };
      }
      const result = await this.deps.run(job);
      const problem = cronFailure(result);
      // A job whose condition said "not now" did what it was written to do,
      // so it is healthy rather than nothing having happened.
      this.deps.runs.finish(runId, problem ? "error" : result.ran ? "ok" : "skipped", problem);
      this.deps.report(key, job.name, problem === null, problem);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.runs.finish(runId, "error", message);
      this.deps.report(key, job.name, false, message);
      throw err;
    }
  }

  /**
   * Forget failures belonging to jobs that no longer exist.
   *
   * A broken job that gets deleted, by the owner or by a fix attempt that
   * decided removing it was the repair, left its failure in the health
   * report and the header counting it forever, with Dismiss as the only way
   * out. Hung off the reload, which every path that changes a job calls.
   */
  private pruneHealth(): void {
    const alive = new Set(this.deps.crons.list().map((c) => `cron:${c.id}`));
    for (const failing of this.deps.health.failing()) {
      if (failing.key.startsWith("cron:") && !alive.has(failing.key)) {
        this.deps.health.forget(failing.key);
      }
    }
  }
}
