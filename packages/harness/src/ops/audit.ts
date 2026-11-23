import type { SecretsRegistry } from "../secrets/secrets.js";
import type { Db } from "../store/db.js";
import type { RiskTier } from "../risk/tiers.js";
import type { StepTally } from "./outcome.js";
import { caller } from "../kernel/caller.js";

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  riskTier?: RiskTier;
  userId?: string;
  /** Who let a risky call run when the owner was not asked: "auto mode" for a chat set to Auto. */
  approvedBy?: string;
  /** The conversation whose turn made the call; the calling turn's when not said. */
  conversationId?: string;
}

export interface AuditRecord {
  id: number;
  tool: string;
  args: string;
  result: string;
  isError: boolean;
  riskTier: RiskTier | null;
  userId: string | null;
  approvedBy: string | null;
  conversationId: string | null;
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
  approved_by: string | null;
  conversation_id: string | null;
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
    approvedBy: row.approved_by ?? null,
    conversationId: row.conversation_id ?? null,
    createdAt: row.created_at,
  };
}

/**
 * The audit table as this code reads and writes it: made when missing, and
 * an older one given the columns added since, in place, so its history keeps
 * its rows. Called by anything that reads the table without the log itself.
 */
export function ensureAuditSchema(db: Db): void {
  db.exec(SCHEMA);
  const columns = db.prepare(`PRAGMA table_info(audit_log)`).all() as { name: string }[];
  // Whose turn wrote a file is then known, not inferred.
  if (!columns.some((c) => c.name === "conversation_id")) db.exec(`ALTER TABLE audit_log ADD COLUMN conversation_id TEXT`);
  // Who let a risky call run unasked: Auto's own runs are then told apart.
  if (!columns.some((c) => c.name === "approved_by")) db.exec(`ALTER TABLE audit_log ADD COLUMN approved_by TEXT`);
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
    ensureAuditSchema(this.db);
  }

  private redact(text: string): string {
    return this.secrets ? this.secrets.redact(text) : text;
  }

  record(entry: AuditEntry): number {
    const args = this.redact(JSON.stringify(entry.args));
    const result = this.redact(entry.result);
    const info = this.db
      .prepare(
        `INSERT INTO audit_log (tool, args, result, is_error, risk_tier, user_id, approved_by, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tool,
        args,
        result,
        entry.isError ? 1 : 0,
        entry.riskTier ?? null,
        entry.userId ?? null,
        entry.approvedBy ?? null,
        entry.conversationId ?? caller.getStore() ?? null,
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

  /**
   * Calls whose tool or arguments hold `term`, newest first: the palette's
   * search of what KOS did. Any case for ASCII, as SQLite lowers only that;
   * instr rather than LIKE, for the reason `touching` gives.
   */
  search(term: string, limit = 20): AuditRecord[] {
    const needle = term.trim().toLowerCase();
    if (needle === "") return [];
    const rows = this.db
      .prepare(`SELECT * FROM audit_log WHERE instr(lower(tool), ?) > 0 OR instr(lower(args), ?) > 0 ORDER BY id DESC LIMIT ?`)
      .all(needle, needle, limit) as Row[];
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

  /** The newest call's id, 0 before any: a mark to count a run's own calls from. */
  lastId(): number {
    const row = this.db.prepare(`SELECT MAX(id) AS id FROM audit_log`).get() as { id: number | null };
    return row.id ?? 0;
  }

  /** The calls one chat made after a mark, and the first that failed: one run's steps, for its outcome. */
  tally(conversationId: string, afterId: number): StepTally {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_error), 0) AS failed FROM audit_log WHERE conversation_id = ? AND id > ?`)
      .get(conversationId, afterId) as { total: number; failed: number };
    const first = row.failed > 0
      ? (this.db
          .prepare(`SELECT tool, result FROM audit_log WHERE conversation_id = ? AND id > ? AND is_error = 1 ORDER BY id LIMIT 1`)
          .get(conversationId, afterId) as { tool: string; result: string })
      : undefined;
    return { total: row.total, failed: row.failed, firstError: first ? `${first.tool}: ${first.result}` : null };
  }

  /** How many calls of one tool a chat made after a mark that ran and worked: what a turn actually delivered. */
  worked(conversationId: string, afterId: number, tool: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE conversation_id = ? AND id > ? AND tool = ? AND is_error = 0`)
      .get(conversationId, afterId, tool) as { n: number };
    return row.n;
  }

  /** One call in full, for a reader who opened it. */
  get(id: number): AuditRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM audit_log WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }
}
