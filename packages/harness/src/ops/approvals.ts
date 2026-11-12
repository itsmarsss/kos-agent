import type { ToolRegistry } from "../agent/registry.js";
import type { GuestOrigin } from "../kernel/caller.js";
import type { RiskTier } from "../risk/tiers.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { Db } from "../store/db.js";

/** Expired: nobody decided in time. Reads as a refusal to the caller, and says why. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

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
  /** The rule a yes-and-remember would keep, named when the call was queued. */
  rule?: { tool: string; scope: string | null; project: string | null };
  /** A picture of what the call would act on: a browser tab, base64 JPEG. */
  picture?: string;
  /** What the agent said just before it asked: the reason, in its own words. */
  why?: string;
  /** Whether the turn that asked was the owner's own, and attended: what an orphaned approval runs as. */
  owner?: boolean;
  attended?: boolean;
  /** The guest's room, when a guest's words started the asking turn: an orphaned approval reaches no further. */
  guest?: GuestOrigin;
  /** The asking turn holds for the answer, so the ask lapses with the approval window rather than the inbox's hours. */
  waits?: boolean;
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
  /** The rule a yes-and-remember keeps, if the call's shape can be named. */
  rule: { tool: string; scope: string | null; project: string | null } | null;
  /** There is a picture of what it would act on; fetched on its own, it is big. */
  picture: boolean;
  /** The agent's words before the ask, so the ask reads as a sentence and not a command. */
  why: string | null;
  /**
   * Who the asking turn was to the fences. An approval nobody is waiting on
   * any more runs as that turn would have, no more: the owner's reach only
   * if it was the owner's own turn. False for a row from before these were kept.
   */
  owner: boolean;
  attended: boolean;
  /** The guest's room, when a guest's words started the asking turn; null otherwise, and for a row from before. */
  guest: GuestOrigin | null;
  /** Whether a turn held for the answer: its ask lapses with the approval window, not the inbox's. False for a row from before. */
  waits: boolean;
}

/**
 * When an ask lapses, for a card to count down to: a turn held for the
 * answer gives up after the approval window; an ask nothing waits on (a
 * schedule's, a build's) stays in the inbox for its hours.
 */
export function approvalExpiry(action: Pick<PendingAction, "requestedAt" | "waits">, windows: { approvalMinutes: number; approvalExpiryHours: number }): number {
  return action.requestedAt + (action.waits ? windows.approvalMinutes * 60_000 : windows.approvalExpiryHours * 3_600_000);
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
  rule: string | null;
  has_picture: number;
  why: string | null;
  owner: number;
  attended: number;
  guest: string | null;
  waits: number;
}

/** Every column a listed action needs: the picture is only whether there is one, read on its own when shown. */
const LIST_COLUMNS = `id, tool, args, risk_tier, reason, status, user_id, conversation_id, requested_at, decided_at, decided_by, rule, (picture IS NOT NULL) AS has_picture, why, owner, attended, guest, waits`;

/** The most decided asks one page may hold. */
export const DECIDED_MAX = 500;

/** One page of the decided history: after a row, of one outcome, matching some words. */
export interface DecidedPage {
  limit?: number;
  before?: { decidedAt: number; id: number };
  status?: Exclude<ApprovalStatus, "pending">;
  q?: string;
}

/** A stored guest's room; a row without its chat reaches no chat of its own. */
function guestOf(stored: { project: string | null; chat?: string; home?: string }): GuestOrigin {
  return { project: stored.project ?? undefined, chat: stored.chat ?? "", ...(stored.home ? { home: stored.home } : {}) };
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
    rule: row.rule ? (JSON.parse(row.rule) as PendingAction["rule"]) : null,
    picture: row.has_picture === 1,
    why: row.why ?? null,
    owner: row.owner === 1,
    attended: row.attended === 1,
    guest: row.guest === null ? null : guestOf(JSON.parse(row.guest) as { project: string | null; chat?: string; home?: string }),
    waits: row.waits === 1,
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
  /** Turns suspended on a decision, by pending-action id. */
  private readonly waiters = new Map<number, (status: ApprovalStatus) => void>();

  /**
   * Told when an action is decided.
   *
   * A build blocked on a permission prompt polled the row every 500ms, which
   * is a busy loop that also makes the owner wait up to half a second after
   * they have already answered. Listeners are woken the moment the decision
   * lands instead.
   */
  private readonly listeners = new Set<(action: PendingAction) => void>();

  onDecided(listener: (action: PendingAction) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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
    if (!columns.some((c) => c.name === "rule")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN rule TEXT`);
    }
    if (!columns.some((c) => c.name === "picture")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN picture TEXT`);
    }
    if (!columns.some((c) => c.name === "why")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN why TEXT`);
    }
    // A row from before is nobody's turn in particular: neither the owner's nor attended.
    if (!columns.some((c) => c.name === "owner")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN owner INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((c) => c.name === "attended")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN attended INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((c) => c.name === "guest")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN guest TEXT`);
    }
    if (!columns.some((c) => c.name === "waits")) {
      this.db.exec(`ALTER TABLE pending_actions ADD COLUMN waits INTEGER NOT NULL DEFAULT 0`);
    }
    // The decided history is read by outcome and time, a page at a time.
    this.db.exec(`CREATE INDEX IF NOT EXISTS pending_actions_status_decided ON pending_actions (status, decided_at, id)`);
  }

  /** The picture queued with an action, if one was: base64 JPEG. */
  pictureOf(id: number): string | undefined {
    const row = this.db.prepare(`SELECT picture FROM pending_actions WHERE id = ?`).get(id) as { picture: string | null } | undefined;
    return row?.picture ?? undefined;
  }

  enqueue(input: EnqueueInput): PendingAction {
    const argsJson = JSON.stringify(input.args);
    const args = this.secrets ? this.secrets.redact(argsJson) : argsJson;
    const info = this.db
      .prepare(
        `INSERT INTO pending_actions (tool, args, risk_tier, reason, user_id, conversation_id, requested_at, rule, picture, why, owner, attended, guest, waits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tool,
        args,
        input.riskTier,
        input.reason ?? null,
        input.userId ?? null,
        input.conversationId ?? null,
        this.now(),
        input.rule ? JSON.stringify(input.rule) : null,
        input.picture ?? null,
        input.why?.trim() ? input.why.trim() : null,
        input.owner === true ? 1 : 0,
        input.attended === true ? 1 : 0,
        input.guest ? JSON.stringify({ project: input.guest.project ?? null, chat: input.guest.chat, ...(input.guest.home ? { home: input.guest.home } : {}) }) : null,
        input.waits === true ? 1 : 0,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): PendingAction | undefined {
    const row = this.db
      .prepare(`SELECT ${LIST_COLUMNS} FROM pending_actions WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toAction(row) : undefined;
  }

  /**
   * What was decided, newest first, a page at a time: approved, denied or
   * lapsed, so a reference to an old ask still lands.
   *
   * The Inbox read the latest 500 whole on every poll, pictures and all,
   * which on a busy workspace was megabytes a few seconds apart. A page
   * names its columns (never the picture), starts after the last row of the
   * one before it, and can be held to one outcome or a few words.
   */
  decided(page: DecidedPage = {}): PendingAction[] {
    const where = [`status ${page.status ? "= ?" : "!= 'pending'"}`];
    const params: (string | number)[] = page.status ? [page.status] : [];
    if (page.before) {
      where.push(`(decided_at < ? OR (decided_at = ? AND id < ?))`);
      params.push(page.before.decidedAt, page.before.decidedAt, page.before.id);
    }
    const q = page.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(`(tool LIKE ? ESCAPE '\\' OR args LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR why LIKE ? ESCAPE '\\' OR id = ?)`);
      params.push(like, like, like, like, Number(q.replace(/^#/, "")) || -1);
    }
    const limit = Math.max(1, Math.min(DECIDED_MAX, Math.floor(page.limit ?? 25)));
    const rows = this.db
      .prepare(`SELECT ${LIST_COLUMNS} FROM pending_actions WHERE ${where.join(" AND ")} ORDER BY decided_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as Row[];
    return rows.map(toAction);
  }

  /** How many were decided, by outcome, for the Inbox's filters. */
  decidedCounts(): Record<Exclude<ApprovalStatus, "pending">, number> {
    const counts = { approved: 0, denied: 0, expired: 0 };
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM pending_actions WHERE status != 'pending' GROUP BY status`).all() as { status: string; n: number }[];
    for (const r of rows) if (r.status in counts) counts[r.status as keyof typeof counts] = r.n;
    return counts;
  }

  /** What the decided history looks like right now, so a reader can tell whether it changed without reading it. */
  decidedMark(): { total: number; latest: number | null } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM pending_actions WHERE status != 'pending'`).get() as { n: number }).n;
    const last = this.db.prepare(`SELECT id FROM pending_actions WHERE status != 'pending' ORDER BY decided_at DESC, id DESC LIMIT 1`).get() as { id: number } | undefined;
    return { total, latest: last?.id ?? null };
  }

  pending(): PendingAction[] {
    const rows = this.db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM pending_actions WHERE status = 'pending' ORDER BY id`,
      )
      .all() as Row[];
    return rows.map(toAction);
  }

  /**
   * Wait for the owner to decide about one action.
   *
   * A queued call used to end the turn: the model was told to stop, and
   * approving started a fresh turn to continue. That is why the live view
   * emptied on approval, why a second tool bubble appeared for the same call,
   * and why several calls queued at once could not be resolved together.
   * Awaiting instead suspends the turn where it stands, so it carries on with
   * the real result in the same breath.
   *
   * Bounded, because a turn that waits forever holds its conversation's queue
   * forever. A decision that never comes reads as a refusal, and the ask
   * lapses with the wait: it left the inbox and every prompt for it settled
   * the moment the turn stopped waiting, rather than sitting there for a
   * decision nothing would act on.
   */
  waitFor(id: number, timeoutMs: number): Promise<ApprovalStatus> {
    const current = this.get(id);
    if (current && current.status !== "pending") {
      return Promise.resolve(current.status);
    }
    return new Promise<ApprovalStatus>((resolve) => {
      const timer = setTimeout(() => {
        // Deciding wakes the waiter set below; only a race with a real
        // decision leaves nothing to wake, and then that decision stands.
        if (!this.decide(id, "expired", "timeout")) {
          this.waiters.delete(id);
          resolve(this.get(id)?.status ?? "expired");
        }
      }, timeoutMs);
      // Unref so a pending decision cannot keep the process alive on its own.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.waiters.set(id, (status) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(status);
      });
    });
  }

  /** Whether a turn is currently suspended on this action. */
  isAwaited(id: number): boolean {
    return this.waiters.has(id);
  }

  approve(id: number, decidedBy: string): PendingAction | undefined {
    return this.decide(id, "approved", decidedBy);
  }

  deny(id: number, decidedBy: string): PendingAction | undefined {
    return this.decide(id, "denied", decidedBy);
  }

  /** An ask nothing will act on any more, settled as lapsed: the turn waiting on it was stopped. */
  lapse(id: number, decidedBy: string): PendingAction | undefined {
    return this.decide(id, "expired", decidedBy);
  }

  /**
   * Asks nobody has answered in a long while lapse. An unattended run queues
   * its ask and moves on, and a turn cut by a restart leaves its ask behind;
   * either way the inbox is for today's decisions, not last week's.
   */
  expire(maxAgeMs: number): PendingAction[] {
    const rows = this.db
      .prepare(`SELECT id FROM pending_actions WHERE status = 'pending' AND requested_at <= ? ORDER BY id`)
      .all(this.now() - maxAgeMs) as { id: number }[];
    return rows.map((r) => this.decide(r.id, "expired", "timeout")).filter((a): a is PendingAction => a !== undefined);
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
    if (info.changes === 0) return undefined;
    const decided = this.get(id);
    // Before the listeners: whoever is suspended on this should be moving
    // again before anything else reacts to the decision.
    this.waiters.get(id)?.(status);
    if (decided) {
      for (const listener of this.listeners) {
        try {
          listener(decided);
        } catch {
          // A listener that throws is a broken waiter, not a broken decision.
        }
      }
    }
    return decided;
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
