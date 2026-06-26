/**
 * Serial work queue: one job at a time, so there are no concurrent DB writes and
 * no cron-vs-chat races. Tasks run in enqueue order; a task that throws rejects
 * its own promise but does not break the chain for the next task.
 */
export class WorkQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    this.pending += 1;
    const run = this.tail.then(() => task());
    // Keep the chain alive regardless of this task's outcome.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    void run.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return run;
  }

  /** Queue depth, for the dashboard status strip. */
  get depth(): number {
    return this.pending;
  }

  /** Resolve once all currently-queued work has settled. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
