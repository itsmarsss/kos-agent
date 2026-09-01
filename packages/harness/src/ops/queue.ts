/**
 * Work queues, one per lane.
 *
 * This was a single serial queue for the whole process: one job at a time,
 * whatever it was. That is more serialisation than the problem needs, and it
 * meant a long turn in one chat blocked every other chat, a cron job, and an
 * approval — the owner would send a message somewhere else and watch nothing
 * happen for a minute with no sign why.
 *
 * A lane is a key. Work in the same lane runs in order, one at a time, which
 * is what a conversation needs: a follow-up must not overtake the turn it was
 * queued behind. Work in different lanes runs concurrently, which is what
 * separate chats need.
 *
 * What this does not do is make the tools inside a turn safe to run in
 * parallel with each other. SQLite statements are individually atomic, and the
 * remaining hazard is a read-modify-write split across an await inside one
 * tool. Anything with that shape belongs in the shared lane rather than being
 * given its own.
 */

/** The lane for work that must not overlap anything else of its kind. */
export const SHARED_LANE = "shared";

export class WorkQueue {
  /** Tail promise per lane. A lane with nothing queued is dropped. */
  private readonly tails = new Map<string, Promise<unknown>>();
  private pending = 0;
  private readonly perLane = new Map<string, number>();

  /**
   * Run a task in a lane. Tasks in one lane run in enqueue order; a task that
   * throws rejects its own promise without breaking the lane for the next.
   */
  enqueue<T>(task: () => Promise<T> | T, lane: string = SHARED_LANE): Promise<T> {
    this.pending += 1;
    this.perLane.set(lane, (this.perLane.get(lane) ?? 0) + 1);

    const previous = this.tails.get(lane) ?? Promise.resolve();
    const run = previous.then(() => task());

    // Keep the lane alive regardless of this task's outcome.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(lane, settled);

    void settled.then(() => {
      this.pending -= 1;
      const left = (this.perLane.get(lane) ?? 1) - 1;
      if (left <= 0) {
        this.perLane.delete(lane);
        // Only if nothing else has queued behind it, or a later task would be
        // orphaned from the chain it is waiting on.
        if (this.tails.get(lane) === settled) this.tails.delete(lane);
      } else {
        this.perLane.set(lane, left);
      }
    });

    return run;
  }

  /** Everything queued anywhere, for the dashboard status strip. */
  get depth(): number {
    return this.pending;
  }

  /** How much is queued in one lane, which is what "am I behind" means. */
  depthOf(lane: string): number {
    return this.perLane.get(lane) ?? 0;
  }

  /** Resolve once everything currently queued has settled. */
  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}
