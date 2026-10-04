/**
 * Looking around without being asked.
 *
 * Everything else KOS does starts with the owner: a message, or a schedule
 * they wrote. So it only ever acts at times they thought of in advance, which
 * makes it a very good tool and not much of an assistant. A heartbeat is the
 * other half -- it wakes up on its own, reads what has changed, and decides
 * whether any of it is worth saying.
 *
 * The whole design problem is restraint. Something that reports in every
 * half hour to say there is nothing to report is worse than silence, because
 * the owner learns to ignore it and then misses the one that mattered. So
 * saying nothing is the default and the normal outcome: the run ends, the
 * thread records that it looked, and the owner hears nothing unless the agent
 * chose to call notify.
 *
 * Off unless the owner turns it on. This is the only thing in KOS that spends
 * money on a timer rather than because someone asked for something.
 */

/** The conversation heartbeats run in, so they never crowd a real chat. */
export const HEARTBEAT_SESSION = "heartbeat:owner";

/**
 * What the agent is asked, when nobody asked it anything.
 *
 * Written to make silence easy and comfortable. It says what "worth saying"
 * means, gives leave to do nothing, and asks for one message rather than a
 * report, because a heartbeat that files a status update every time is the
 * failure mode this is trying to avoid.
 */
export const HEARTBEAT_PROMPT = [
  "Nobody asked you anything. You have woken up on your own to see whether",
  "anything needs the owner's attention.",
  "",
  "Look at what you can see: scheduled jobs that failed, work you said you",
  "would come back to, mail that arrived if you have a tool that reads it,",
  "anything you noticed last time and left. Use your tools to check rather",
  "than guessing from memory.",
  "",
  "Then decide. Almost always the honest answer is that nothing needs them,",
  "and in that case say nothing at all: end the turn without calling notify.",
  "Silence is the normal outcome and is not a failure.",
  "",
  "Call notify only if there is something they would want interrupting for,",
  "and then send one short message saying the thing itself, not a summary of",
  "having looked. Do not report that you checked. Do not send a status",
  "update. Do not repeat something you already told them.",
].join("\n");

export interface HeartbeatDeps {
  /** Minutes between beats, read fresh each time so a change takes effect. */
  interval: () => number;
  /** Run one look-around. Rejections are swallowed; a beat is best-effort. */
  beat: () => Promise<void>;
  /** False when KOS is halted, or has already self-prompted too often. */
  allowed: () => boolean;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * A timer that re-reads its own interval.
 *
 * Scheduled one beat at a time rather than on a fixed interval, so changing
 * the setting takes effect at the next beat instead of needing a restart,
 * and so a slow beat cannot overlap the next one.
 */
/** What one beat needs from the kernel, and nothing more. */
export interface BeatDeps {
  ownerId: string;
  /** Serialise with everything else that talks to the model. */
  enqueue: (work: () => Promise<void>, lane: string) => Promise<void>;
  runs: { start: (kind: string, ref: string) => number; finish: (id: number, status: "ok" | "error", error?: string) => void };
  /** Make sure the heartbeat's own thread exists before speaking in it. */
  conversationFor: (channel: string, ownerId: string) => unknown;
  /** Run the look-around as a system turn in that thread. */
  runTurn: (text: string, userId: string, sessionId: string, opts: { origin: "system" }) => Promise<unknown>;
}

/**
 * One look-around: a system turn in the heartbeat's own thread, recorded as
 * a run so a failed beat is visible in History rather than lost. Built here
 * so the kernel only has to say when; what a beat is lives with the timer.
 */
export function heartbeatBeat(deps: BeatDeps): () => Promise<void> {
  return () =>
    deps.enqueue(async () => {
      const runId = deps.runs.start("heartbeat", HEARTBEAT_SESSION);
      try {
        deps.conversationFor("heartbeat", deps.ownerId);
        await deps.runTurn(HEARTBEAT_PROMPT, deps.ownerId, HEARTBEAT_SESSION, { origin: "system" });
        deps.runs.finish(runId, "ok");
      } catch (err) {
        deps.runs.finish(runId, "error", err instanceof Error ? err.message : String(err));
      }
    }, HEARTBEAT_SESSION);
}

export class Heartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly deps: HeartbeatDeps) {
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Whether a beat is currently due to happen. */
  get pending(): boolean {
    return this.timer !== undefined;
  }

  private schedule(): void {
    if (!this.running) return;
    const minutes = this.deps.interval();
    if (minutes <= 0) {
      /*
       * Off, but not stopped. Checked again on the same cadence so turning it
       * on in settings starts it without a restart; a minute of idle timer is
       * cheaper than making the owner remember to bounce the host.
       */
      this.timer = this.setTimer(() => void this.tick(false), 60_000);
      return;
    }
    this.timer = this.setTimer(() => void this.tick(true), minutes * 60_000);
  }

  private async tick(due: boolean): Promise<void> {
    this.timer = undefined;
    if (!this.running) return;
    if (due && this.deps.allowed()) {
      try {
        await this.deps.beat();
      } catch {
        // A beat nobody asked for is not worth reporting a failure over; the
        // run log has it, and the next one is a few minutes away.
      }
    }
    this.schedule();
  }
}
