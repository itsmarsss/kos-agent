import type { SecretSurface, SecretUseRow } from "@kos/shared";

import type { Db } from "../store/db.js";

/**
 * Each time a secret was used, or refused: where, by which tool, which
 * fields, and how it went. Never a value. The Secrets page lists these per
 * secret; the vault holds the secret itself, outside the workspace.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secret_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  conversation_id TEXT,
  tool TEXT NOT NULL,
  surface TEXT NOT NULL,
  device_id TEXT,
  origin TEXT,
  frame_origin TEXT,
  app TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL,
  approval_id INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS secret_uses_by_secret ON secret_uses (secret_id, at DESC);
`;

interface Row {
  id: number;
  secret_id: string;
  at: number;
  conversation_id: string | null;
  tool: string;
  surface: SecretSurface;
  device_id: string | null;
  origin: string | null;
  frame_origin: string | null;
  app: string | null;
  fields: string;
  outcome: string;
  approval_id: number | null;
  decided_by: string | null;
}

export interface SecretUseInput {
  secret: string;
  tool: string;
  surface: SecretSurface;
  outcome: string;
  fields?: string[];
  conversationId?: string;
  deviceId?: string;
  origin?: string;
  frameOrigin?: string;
  app?: string;
  approvalId?: number;
  decidedBy?: string;
}

const MAX_LIMIT = 500;

function toUse(r: Row): SecretUseRow {
  return {
    id: r.id,
    at: r.at,
    tool: r.tool,
    surface: r.surface,
    fields: JSON.parse(r.fields) as string[],
    outcome: r.outcome,
    ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
    ...(r.origin ? { origin: r.origin } : {}),
    ...(r.frame_origin ? { frameOrigin: r.frame_origin } : {}),
    ...(r.app ? { app: r.app } : {}),
    ...(r.approval_id !== null ? { approvalId: r.approval_id } : {}),
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
  };
}

export class SecretUses {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  record(use: SecretUseInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO secret_uses (secret_id, at, conversation_id, tool, surface, device_id, origin, frame_origin, app, fields, outcome, approval_id, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        use.secret,
        this.now(),
        use.conversationId ?? null,
        use.tool,
        use.surface,
        use.deviceId ?? null,
        use.origin ?? null,
        use.frameOrigin ?? null,
        use.app ?? null,
        JSON.stringify(use.fields ?? []),
        use.outcome,
        use.approvalId ?? null,
        use.decidedBy ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  /** A secret's uses, newest first. */
  list(secret: string, limit = 50): SecretUseRow[] {
    const n = Math.min(Math.max(1, Math.floor(limit) || 50), MAX_LIMIT);
    return (this.db.prepare(`SELECT * FROM secret_uses WHERE secret_id = ? ORDER BY at DESC, id DESC LIMIT ?`).all(secret, n) as Row[]).map(toUse);
  }

  /** When each secret was last filled, by handle. */
  lastUsed(): Map<string, number> {
    const rows = this.db.prepare(`SELECT secret_id, MAX(at) AS at FROM secret_uses WHERE outcome = 'filled' GROUP BY secret_id`).all() as { secret_id: string; at: number }[];
    return new Map(rows.map((r) => [r.secret_id, r.at]));
  }

  /** A deleted secret's history goes with it. */
  forget(secret: string): void {
    this.db.prepare(`DELETE FROM secret_uses WHERE secret_id = ?`).run(secret);
  }
}
