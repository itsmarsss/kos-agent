import type { SecretsRegistry } from "../secrets/secrets.js";
import type { Db } from "../store/db.js";
import type { RiskTier } from "../risk/tiers.js";

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  riskTier?: RiskTier;
  userId?: string;
}

export interface AuditRecord {
  id: number;
  tool: string;
  args: string;
  result: string;
  isError: boolean;
  riskTier: RiskTier | null;
  userId: string | null;
  createdAt: number;
}

/** Calls in one hour, for a chart of how busy KOS has been. */
export interface HourCount {
  /** Start of the hour, epoch ms. */
  hour: number;
  calls: number;
  errors: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  result TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  risk_tier TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);
`;

interface Row {
  id: number;
  tool: string;
  args: string;
  result: string;
  is_error: number;
  risk_tier: string | null;
  user_id: string | null;
  created_at: number;
}

function toRecord(row: Row): AuditRecord {
  return {
    id: row.id,
    tool: row.tool,
    args: row.args,
    result: row.result,
    isError: row.is_error === 1,
    riskTier: row.risk_tier as RiskTier | null,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

/**
 * Append-only record of every tool call. Args and results are redacted through
 * the secrets registry before storage, so keys never leak into history.
 */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly secrets?: SecretsRegistry,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  private redact(text: string): string {
    return this.secrets ? this.secrets.redact(text) : text;
  }

  record(entry: AuditEntry): number {
    const args = this.redact(JSON.stringify(entry.args));
    const result = this.redact(entry.result);
    const info = this.db
      .prepare(
        `INSERT INTO audit_log (tool, args, result, is_error, risk_tier, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tool,
        args,
        result,
        entry.isError ? 1 : 0,
        entry.riskTier ?? null,
        entry.userId ?? null,
        this.now(),
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Tool calls that mention a project, newest first.
   *
   * A project's tables, pages and folders are all named after its slug, so
   * the slug appearing in a call's arguments is a good enough answer to
   * "what has been done to this thing". Matched with instr rather than LIKE:
   * a slug contains underscores, LIKE reads those as wildcards, and a pattern
   * that looks exact but is not has already caused one silent bug here.
   */
  touching(slug: string, limit = 20): AuditRecord[] {
    if (slug === "") return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log
         WHERE instr(args, ?) > 0 OR instr(result, ?) > 0
         ORDER BY id DESC LIMIT ?`,
      )
      .all(slug, slug, limit) as Row[];
    return rows.map(toRecord);
  }

  recent(limit = 50): AuditRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(toRecord);
  }

  /**
   * Calls per hour since a moment, oldest first. Only hours with a call come
   * back; a chart pads the quiet ones. `hour` is the start of the hour in ms.
   */
  byHour(since: number): HourCount[] {
    return this.db
      .prepare(
        `SELECT (created_at / 3600000) * 3600000 AS hour,
                COUNT(*) AS calls,
                SUM(is_error) AS errors
         FROM audit_log WHERE created_at >= ?
         GROUP BY hour ORDER BY hour`,
      )
      .all(since) as HourCount[];
  }

  /** One call in full, for a reader who opened it. */
  get(id: number): AuditRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM audit_log WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }
}
