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

  recent(limit = 50): AuditRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(toRecord);
  }
}
