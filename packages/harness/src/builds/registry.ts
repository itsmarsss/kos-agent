import type { BuildControl, BuildEvent, BuildPhase, BuildUsage } from "./runner.js";

/**
 * The build sub-agents that are running right now.
 *
 * A build is a Claude Code instance working inside the workspace for minutes
 * at a time. Started from a tool call and never mentioned again, the only sign
 * of one was a chat that had gone quiet: no way to see what it was doing, how
 * long it had been at it, or to stop one that had clearly gone wrong.
 *
 * Kept in memory rather than in the database on purpose. A build belongs to
 * the process running it: if KOS restarts, its children are gone, and a list
 * that survived the restart would be a list of agents that no longer exist.
 */

export type BuildStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export interface BuildRecord {
  id: number;
  /** Workspace-relative folder it is confined to. */
  dir: string;
  /** What it was asked to do. */
  task: string;
  /** The conversation that started it. */
  conversationId?: string;
  status: BuildStatus;
  startedAt: number;
  endedAt?: number;
  /** Most recent thing it did, for a one-line view. */
  latest: string;
  /** What it has done, newest last, capped. */
  events: (BuildEvent & { at: number })[];
  /** Tokens and money so far, once a turn has completed. */
  usage?: BuildUsage;
  /** What it is doing at this instant, as opposed to what it has done. */
  phase?: BuildPhase;
  /** When it started doing that, so a reader can see how long it has been. */
  phaseSince?: number;
  /** Files it has touched so far. */
  files: string[];
  /** Times it has stopped to ask the owner something. */
  askedFor: number;
  /** Queued actions this build is waiting on, so a reader sees only its own. */
  waitingOn: number[];
  /**
   * Milliseconds of silence, when a working build has been quiet long enough
   * to be worth flagging. Zero otherwise.
   */
  quietFor?: number;
}

/*
 * Enough to read a build like a terminal.
 *
 * Was 200, which is a summary rather than a log: opening a build that had been
 * working for ten minutes showed the tail and nothing of how it got there.
 */
const MAX_EVENTS = 2000;
/** Finished builds worth still showing, newest first. */
const MAX_FINISHED = 20;

/**
 * How long a working build may say nothing before it is called stalled.
 *
 * A build that is thinking and a build that is wedged look identical from
 * outside: both say "running" and produce nothing. Most turns produce output
 * within seconds, so silence for minutes is worth naming rather than leaving
 * the owner to watch a spinner and guess.
 */
const SILENCE_MS = 3 * 60_000;

export class BuildRegistry {
  private readonly records = new Map<number, BuildRecord>();
  private readonly controls = new Map<number, BuildControl>();
  /**
   * Told whenever a build changes, so a reader can be streamed rather than
   * poll. Polling every second and a half is fine for a list and wrong for a
   * log: output arrives in bursts and reads as stuttering.
   */
  private readonly watchers = new Set<(id: number) => void>();
  private nextId = 1;

  watch(listener: (id: number) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  private changed(id: number): void {
    for (const watcher of this.watchers) {
      try {
        watcher(id);
      } catch {
        // A broken reader is not a broken build.
      }
    }
  }

  /** Register a build about to start. Returns its id. */
  start(input: {
    dir: string;
    task: string;
    conversationId?: string;
    control: BuildControl;
    now?: number;
  }): number {
    const id = this.nextId++;
    this.records.set(id, {
      id,
      dir: input.dir,
      task: input.task,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      status: "running",
      startedAt: input.now ?? Date.now(),
      latest: "starting",
      events: [],
      files: [],
      askedFor: 0,
      waitingOn: [],
    });
    this.controls.set(id, input.control);
    this.prune();
    this.changed(id);
    return id;
  }

  /** Record something a build did. */
  record(id: number, event: BuildEvent, now = Date.now()): void {
    const record = this.records.get(id);
    if (!record) return;
    // A result is what came back, not what the build is doing; letting it
    // overwrite `latest` made the one-line summary a wall of tool output.
    if (event.kind !== "result") record.latest = event.text.slice(0, 200);
    record.events.push({ ...event, at: now, text: event.text.slice(0, 8000) });
    if (record.events.length > MAX_EVENTS) record.events.shift();
    // Waiting on the owner is a different state from working, and the
    // difference is the whole reason to look at this list.
    if (event.kind === "permission") {
      if (event.text.startsWith("waiting on you")) {
        record.status = "waiting";
        record.askedFor += 1;
      } else if (record.status === "waiting") {
        record.status = "running";
      }
    }
    this.changed(id);
  }

  /** This build is waiting on a decision, or is no longer waiting on one. */
  asking(id: number, pendingId: number, settled: boolean): void {
    const record = this.records.get(id);
    if (!record) return;
    record.waitingOn = settled
      ? record.waitingOn.filter((p) => p !== pendingId)
      : [...new Set([...record.waitingOn, pendingId])];
    this.changed(id);
  }

  /** What it is doing now. Cheap and frequent; never added to the log. */
  doing(id: number, phase: BuildPhase, now = Date.now()): void {
    const record = this.records.get(id);
    if (!record) return;
    // The clock only restarts when the phase itself changes, so "thinking for
    // 40s" keeps counting rather than resetting on every delta.
    if (record.phase?.phase !== phase.phase) record.phaseSince = now;
    record.phase = phase;
    this.changed(id);
  }

  /** Record what a turn cost. */
  spent(id: number, usage: BuildUsage): void {
    const record = this.records.get(id);
    if (record) record.usage = usage;
    this.changed(id);
  }

  /** A build has answered its permission prompt and is working again. */
  resumed(id: number): void {
    const record = this.records.get(id);
    if (record && record.status === "waiting") record.status = "running";
  }

  finish(
    id: number,
    outcome: { ok: boolean; summary: string; files: string[] },
    now = Date.now(),
  ): void {
    const record = this.records.get(id);
    if (!record) return;
    const wasStopped = record.status === "stopped";
    record.status = wasStopped ? "stopped" : outcome.ok ? "done" : "failed";
    record.endedAt = now;
    // A stopped build keeps the reason it was stopped. The run that was
    // aborted reports its own version of events afterwards, and overwriting
    // with that told the owner it had failed when they had stopped it.
    if (!wasStopped) record.latest = outcome.summary.slice(0, 200);
    record.files = outcome.files;
    delete record.phase;
    delete record.phaseSince;
    this.controls.delete(id);
    this.changed(id);
  }

  /**
   * Stop a build. Returns false when there is nothing to stop, which is the
   * normal answer for one that finished while the owner was reading about it.
   */
  stop(id: number): boolean {
    const control = this.controls.get(id);
    const record = this.records.get(id);
    if (!control || !record) return false;
    record.status = "stopped";
    record.latest = "stopped by you";
    this.controls.delete(id);
    try {
      control.stop();
    } catch {
      // The build is marked stopped either way; a failed abort is not
      // something the owner can act on.
    }
    return true;
  }

  /**
   * Say something to a build that is still going.
   *
   * This is the difference between watching an agent go the wrong way and
   * being able to tell it so. Returns false when there is nothing running to
   * say it to.
   */
  send(id: number, text: string): boolean {
    const control = this.controls.get(id);
    if (!control) return false;
    control.send(text);
    // Status deliberately unchanged. A message is not an answer to a pending
    // permission prompt: a build blocked on "may I run this" is still blocked
    // after you say something else, and marking it running claimed it had
    // moved on when it had not. It picks the message up once unblocked.
    return true;
  }

  /**
   * Stop what it is doing now without ending it, so it can be redirected.
   * "That is the wrong file" is an interrupt, not a kill.
   */
  async interrupt(id: number): Promise<boolean> {
    const control = this.controls.get(id);
    if (!control) return false;
    await control.interrupt();
    return true;
  }

  get(id: number): BuildRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Whether a build has gone quiet for long enough to be worth flagging.
   *
   * Derived on read rather than stored, so it becomes true on its own without
   * a timer having to fire.
   */
  private stalled(record: BuildRecord, now: number): boolean {
    if (record.status !== "running") return false;
    // Streaming frames count as signs of life. Without this a build thinking
    // hard for four minutes, which is a perfectly healthy thing to do and now
    // visibly reported as thinking, would be called stalled.
    const last = Math.max(
      record.events.at(-1)?.at ?? record.startedAt,
      record.phaseSince ?? 0,
      record.phase && record.phase.phase !== "idle" ? now : 0,
    );
    return now - last > SILENCE_MS;
  }

  /** Running first, then most recently finished. */
  list(now = Date.now()): BuildRecord[] {
    return [...this.records.values()]
      .map((r) => ({ ...r, quietFor: this.stalled(r, now) ? now - (r.events.at(-1)?.at ?? r.startedAt) : 0 }))
      .sort((a, b) => {
      const aLive = a.status === "running" || a.status === "waiting";
      const bLive = b.status === "running" || b.status === "waiting";
      if (aLive !== bLive) return aLive ? -1 : 1;
      return b.startedAt - a.startedAt;
      });
  }

  /** Builds still going, which is what "is anything happening" means. */
  active(): BuildRecord[] {
    return this.list().filter(
      (r) => r.status === "running" || r.status === "waiting",
    );
  }

  /** Keep the finished ones from growing without bound. */
  private prune(): void {
    const finished = this.list().filter(
      (r) => r.status !== "running" && r.status !== "waiting",
    );
    for (const record of finished.slice(MAX_FINISHED)) {
      this.records.delete(record.id);
    }
  }
}
