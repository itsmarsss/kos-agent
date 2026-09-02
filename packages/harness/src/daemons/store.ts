import type { Db } from "../store/db.js";
import type { Daemon, DaemonRuntime } from "./types.js";

/**
 * The register of long-running programs: what exists, and what should be up.
 *
 * Separate from whether anything is actually running, which is the
 * supervisor's business and does not survive a restart. This is the part that
 * has to: a daemon the owner turned on stays on across a reboot of the host,
 * the same way a cron job does.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daemons (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  entry TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  port INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project, name)
);
`;

interface Row {
  id: number;
  project: string;
  name: string;
  runtime: string;
  entry: string;
  args: string;
  port: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toDaemon(row: Row): Daemon {
  let args: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.args);
    if (Array.isArray(parsed)) args = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    // A row written by hand with bad JSON is a daemon with no extra argv, not
    // a daemon that cannot be listed.
  }
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    runtime: row.runtime === "python" ? "python" : "node",
    entry: row.entry,
    args,
    port: row.port,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewDaemon {
  project: string;
  name: string;
  runtime: DaemonRuntime;
  entry: string;
  args?: string[];
  /** Null for a daemon that listens on nothing. */
  port?: number | null;
  enabled?: boolean;
}

export class DaemonStore {
  constructor(private readonly db: Db) {
    this.db.exec(SCHEMA);
  }

  create(input: NewDaemon): Daemon {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO daemons (project, name, runtime, entry, args, port, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project,
        input.name,
        input.runtime,
        input.entry,
        JSON.stringify(input.args ?? []),
        input.port ?? null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): Daemon | undefined {
    const row = this.db.prepare("SELECT * FROM daemons WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toDaemon(row) : undefined;
  }

  find(project: string, name: string): Daemon | undefined {
    const row = this.db
      .prepare("SELECT * FROM daemons WHERE project = ? AND name = ?")
      .get(project, name) as Row | undefined;
    return row ? toDaemon(row) : undefined;
  }

  list(): Daemon[] {
    const rows = this.db
      .prepare("SELECT * FROM daemons ORDER BY project, name")
      .all() as Row[];
    return rows.map(toDaemon);
  }

  setEnabled(id: number, enabled: boolean): Daemon | undefined {
    this.db
      .prepare("UPDATE daemons SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, Date.now(), id);
    return this.get(id);
  }

  remove(id: number): boolean {
    const result = this.db.prepare("DELETE FROM daemons WHERE id = ?").run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /** Ports already spoken for, so a new daemon is not handed one twice. */
  takenPorts(): Set<number> {
    const rows = this.db
      .prepare("SELECT port FROM daemons WHERE port IS NOT NULL")
      .all() as { port: number }[];
    return new Set(rows.map((r) => r.port));
  }
}
