import type { Db } from "../store/db.js";

export type RunStatus = "running" | "ok" | "error" | "skipped";

export interface RunRecord {
  id: number;
  kind: string;
  ref: string | null;
  status: RunStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs_log (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER
);
`;

interface Row {
  id: number;
  kind: string;
  ref: string | null;
  status: string;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
}

function toRecord(row: Row): RunRecord {
  return {
    id: row.id,
    kind: row.kind,
    ref: row.ref,
    status: row.status as RunStatus,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

/**
 * Append-only log of every cron/job run with status, error, and timing. start()
 * opens a row; finish() closes it with the outcome and duration, so silent
 * failures are visible.
 */
export class RunsLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  start(kind: string, ref: string | null = null): number {
    const info = this.db
      .prepare(
        `INSERT INTO runs_log (kind, ref, status, started_at) VALUES (?, ?, 'running', ?)`,
      )
      .run(kind, ref, this.now());
    return Number(info.lastInsertRowid);
  }

  finish(id: number, status: RunStatus, error: string | null = null): void {
    const row = this.db
      .prepare(`SELECT started_at FROM runs_log WHERE id = ?`)
      .get(id) as { started_at: number } | undefined;
    const finishedAt = this.now();
    const duration = row ? finishedAt - row.started_at : null;
    this.db
      .prepare(
        `UPDATE runs_log SET status = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`,
      )
      .run(status, error, finishedAt, duration, id);
  }

  recent(limit = 50): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(toRecord);
  }

  failures(limit = 50): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs_log WHERE status = 'error' ORDER BY id DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(toRecord);
  }
}
