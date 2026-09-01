import type { Db } from "../store/db.js";

/**
 * Whether KOS is well, and telling the owner when it stops being.
 *
 * The whole pitch is that you text it and get on with your life, which means
 * the failure case is a job that throws at 3am. Until now that wrote a row to
 * runs_log and stopped: no message, no badge, nothing on next open. A cron that
 * had been broken for a week looked exactly like a cron that had nothing to do.
 *
 * Two jobs, then. Decide what the owner is told, and answer "is KOS well".
 *
 * The hard part is the first one, and it is not detection. A job on a
 * one-minute schedule that starts failing would send 1440 messages a day, and
 * an assistant that floods you is one you mute, which leaves you worse off than
 * the silence did. So this notifies on the edges that carry information: the
 * first failure, a few escalation points if it stays broken, a change in the
 * error itself, and the recovery. Everything between those is the same fact
 * repeated.
 *
 * State lives in the database rather than in memory because a host that
 * crash-loops would otherwise re-send its first-failure message on every boot,
 * which is the flood arriving by another door.
 */

/** Consecutive-failure counts worth a second message. */
const ESCALATIONS = [1, 3, 10, 30, 100, 300, 1000];

/** Errors are truncated in messages: a stack trace is not a notification. */
const MAX_ERROR = 300;

/** Runs considered when computing the current failure rate. */
const RECENT_RUNS = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS health_state (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  streak INTEGER NOT NULL,
  error TEXT,
  since INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  notified_at_streak INTEGER
);
`;

export interface HealthNotice {
  kind: "failing" | "recovered";
  key: string;
  text: string;
}

export interface FailingJob {
  key: string;
  label: string;
  /** Consecutive failures, so "once" reads differently from "for two days". */
  streak: number;
  error: string | null;
  /** When the current run of failures started. */
  since: number;
  lastAt: number;
}

export interface HealthReport {
  ok: boolean;
  failing: FailingJob[];
  recent: { total: number; errors: number; rate: number };
}

interface StateRow {
  key: string;
  label: string;
  streak: number;
  error: string | null;
  since: number;
  last_at: number;
  notified_at_streak: number | null;
}

function short(error: string | null): string | null {
  if (!error) return null;
  const flat = error.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR ? `${flat.slice(0, MAX_ERROR)}...` : flat;
}

/** How long it has been broken, in words the owner can act on. */
function howLong(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export class HealthMonitor {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  /**
   * Record how one run went, and return what the owner should be told, if
   * anything. The caller delivers it; deciding and sending are separate so a
   * missing channel cannot lose the state.
   */
  observe(
    key: string,
    label: string,
    ok: boolean,
    error: string | null,
  ): HealthNotice | null {
    const previous = this.db
      .prepare(`SELECT * FROM health_state WHERE key = ?`)
      .get(key) as StateRow | undefined;
    const at = this.now();

    if (ok) {
      if (!previous) return null;
      this.db.prepare(`DELETE FROM health_state WHERE key = ?`).run(key);
      // Only worth saying if the breakage was reported. A job that failed once
      // silently and then worked is not news.
      if (previous.notified_at_streak === null) return null;
      return {
        kind: "recovered",
        key,
        text: `${label} is working again, after ${previous.streak} failed ${
          previous.streak === 1 ? "run" : "runs"
        } over ${howLong(at - previous.since)}.`,
      };
    }

    const message = short(error);
    const changed = previous ? previous.error !== message : false;
    const streak = previous ? previous.streak + 1 : 1;
    const since = previous ? previous.since : at;

    // A different error means the situation changed, so the count starts again
    // from this error's point of view.
    const speak = changed || ESCALATIONS.includes(streak);

    this.db
      .prepare(
        `INSERT INTO health_state (key, label, streak, error, since, last_at, notified_at_streak)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           label = excluded.label,
           streak = excluded.streak,
           error = excluded.error,
           last_at = excluded.last_at,
           notified_at_streak = excluded.notified_at_streak`,
      )
      .run(
        key,
        label,
        streak,
        message,
        since,
        at,
        speak ? streak : (previous?.notified_at_streak ?? null),
      );

    if (!speak) return null;

    const age = at - since;
    const context =
      streak === 1
        ? ""
        : ` It has now failed ${streak} times over ${howLong(age)}.`;
    return {
      kind: "failing",
      key,
      text: `${label} failed: ${message ?? "no error given"}.${context}`,
    };
  }

  /** Forget a job's health, for when the job itself is deleted. */
  forget(key: string): void {
    this.db.prepare(`DELETE FROM health_state WHERE key = ?`).run(key);
  }

  /** Everything currently broken, worst-first. */
  failing(): FailingJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM health_state ORDER BY since ASC`)
      .all() as StateRow[];
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      streak: row.streak,
      error: row.error,
      since: row.since,
      lastAt: row.last_at,
    }));
  }

  /**
   * Is KOS well? Failure rate comes from runs_log rather than from this
   * table, because the table only knows about jobs that are broken right now
   * and the rate is about the trend.
   */
  report(): HealthReport {
    const failing = this.failing();
    const rows = this.db
      .prepare(
        `SELECT status FROM runs_log WHERE status != 'running'
         ORDER BY id DESC LIMIT ?`,
      )
      .all(RECENT_RUNS) as { status: string }[];
    const total = rows.length;
    const errors = rows.filter((r) => r.status === "error").length;
    return {
      ok: failing.length === 0,
      failing,
      recent: { total, errors, rate: total === 0 ? 0 : errors / total },
    };
  }
}
