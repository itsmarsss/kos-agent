import type { BuildEvent } from "./runner.js";

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
  events: { at: number; kind: BuildEvent["kind"]; text: string }[];
  /** Files it has touched so far. */
  files: string[];
  /** Times it has stopped to ask the owner something. */
  askedFor: number;
}

/** Enough to see what happened without keeping a transcript per build. */
const MAX_EVENTS = 200;
/** Finished builds worth still showing, newest first. */
const MAX_FINISHED = 20;

export class BuildRegistry {
  private readonly records = new Map<number, BuildRecord>();
  private readonly stoppers = new Map<number, () => void>();
  private nextId = 1;

  /** Register a build about to start. Returns its id. */
  start(input: {
    dir: string;
    task: string;
    conversationId?: string;
    stop: () => void;
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
    });
    this.stoppers.set(id, input.stop);
    this.prune();
    return id;
  }

  /** Record something a build did. */
  record(id: number, event: BuildEvent, now = Date.now()): void {
    const record = this.records.get(id);
    if (!record) return;
    record.latest = event.text.slice(0, 200);
    record.events.push({ at: now, kind: event.kind, text: event.text.slice(0, 2000) });
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
    this.stoppers.delete(id);
  }

  /**
   * Stop a build. Returns false when there is nothing to stop, which is the
   * normal answer for one that finished while the owner was reading about it.
   */
  stop(id: number): boolean {
    const stopper = this.stoppers.get(id);
    const record = this.records.get(id);
    if (!stopper || !record) return false;
    record.status = "stopped";
    record.latest = "stopped by you";
    this.stoppers.delete(id);
    try {
      stopper();
    } catch {
      // The build is marked stopped either way; a failed abort is not
      // something the owner can act on.
    }
    return true;
  }

  get(id: number): BuildRecord | undefined {
    return this.records.get(id);
  }

  /** Running first, then most recently finished. */
  list(): BuildRecord[] {
    return [...this.records.values()].sort((a, b) => {
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
