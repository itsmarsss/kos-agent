import type { ToolRegistry } from "../agent/registry.js";
import type { RiskTier } from "../risk/tiers.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { Db } from "../store/db.js";

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface EnqueueInput {
  tool: string;
  args: Record<string, unknown>;
  riskTier: RiskTier;
  reason?: string;
  userId?: string;
  /**
   * Which conversation asked. Approving has to resume the agent that was
   * waiting, and that is not always the primary one.
   */
  conversationId?: string;
}

export interface PendingAction {
  id: number;
  tool: string;
  args: string;
  riskTier: RiskTier;
  reason: string | null;
  status: ApprovalStatus;
  userId: string | null;
  conversationId: string | null;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk_tier TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  conversation_id TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
`;

interface Row {
  id: number;
  tool: string;
  args: string;
  risk_tier: string;
  reason: string | null;
  status: string;
  user_id: string | null;
  conversation_id: string | null;
  requested_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

function toAction(row: Row): PendingAction {
  return {
    id: row.id,
    tool: row.tool,
    args: row.args,
    riskTier: row.risk_tier as RiskTier,
    reason: row.reason,
    status: row.status as ApprovalStatus,
    userId: row.user_id,
    conversationId: row.conversation_id,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

/**
 * The approval queue: risky actions land here and wait for the user to
 * approve/deny via a channel (Discord buttons) or the dashboard. Args are
 * redacted through the secrets registry so the queue never stores key values.
 */
export class ApprovalQueue {
  constructor(
    private readonly db: Db,
    private readonly secrets?: SecretsRegistry,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    // Added in place so a workspace with queued actions keeps them.
    const columns = this.db
      .prepare(`PRAGMA table_info(pending_actions)`)
      .all() as { name: string }[];
    if (!columns.some((c) => c.name === "conversation_id")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN conversation_id TEXT`);
    }
  }

  enqueue(input: EnqueueInput): PendingAction {
    const argsJson = JSON.stringify(input.args);
    const args = this.secrets ? this.secrets.redact(argsJson) : argsJson;
    const info = this.db
      .prepare(
        `INSERT INTO pending_actions (tool, args, risk_tier, reason, user_id, conversation_id, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tool,
        args,
        input.riskTier,
        input.reason ?? null,
        input.userId ?? null,
        input.conversationId ?? null,
        this.now(),
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): PendingAction | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pending_actions WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toAction(row) : undefined;
  }

  pending(): PendingAction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY id`,
      )
      .all() as Row[];
    return rows.map(toAction);
  }

  approve(id: number, decidedBy: string): PendingAction | undefined {
    return this.decide(id, "approved", decidedBy);
  }

  deny(id: number, decidedBy: string): PendingAction | undefined {
    return this.decide(id, "denied", decidedBy);
  }

  private decide(
    id: number,
    status: ApprovalStatus,
    decidedBy: string,
  ): PendingAction | undefined {
    // Only a still-pending action can be decided (idempotent against races).
    const info = this.db
      .prepare(
        `UPDATE pending_actions SET status = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, this.now(), decidedBy, id);
    return info.changes > 0 ? this.get(id) : undefined;
  }
}

export type GateDecision =
  | { decision: "run"; riskTier: RiskTier }
  | { decision: "queued"; action: PendingAction };

/**
 * The safety gate for a prospective tool call: classify risk in the harness,
 * run safe calls immediately, and queue risky ones for approval. The caller
 * executes the tool when the decision is "run".
 */
export function gateToolCall(
  registry: ToolRegistry,
  queue: ApprovalQueue,
  name: string,
  input: Record<string, unknown>,
  opts: { reason?: string; userId?: string } = {},
): GateDecision {
  const assessment = registry.classify(name, input);
  if (assessment.tier === "safe") {
    return { decision: "run", riskTier: "safe" };
  }
  const action = queue.enqueue({
    tool: name,
    args: input,
    riskTier: assessment.tier,
    reason: opts.reason,
    userId: opts.userId,
  });
  return { decision: "queued", action };
}
