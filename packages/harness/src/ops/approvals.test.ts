import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { RISKY } from "../risk/tiers.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { ApprovalQueue, approvalExpiry, gateToolCall } from "./approvals.js";

describe("ApprovalQueue", () => {
  let root: string;
  let ws: Workspace;
  let queue: ApprovalQueue;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-appr-"));
    ws = Workspace.open(root);
    queue = new ApprovalQueue(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("enqueues and lists pending actions", () => {
    queue.enqueue({ tool: "shell", args: { cmd: "rm x" }, riskTier: "risky" });
    const pending = queue.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe("shell");
    expect(pending[0]?.status).toBe("pending");
  });

  it("keeps the rule and the picture a call was queued with, and adds the columns to an older table", () => {
    const action = queue.enqueue({ tool: "browser.act", args: { steps: [{ click: "@e5" }] }, riskTier: "risky", rule: { tool: "browser.*", scope: "site:shop.example", project: null }, picture: "UElD", why: "  I'll add it to the cart now. " });
    expect(action.rule).toEqual({ tool: "browser.*", scope: "site:shop.example", project: null });
    expect(action.picture).toBe(true);
    expect(action.why).toBe("I'll add it to the cart now.");
    expect(queue.pictureOf(action.id)).toBe("UElD");
    const plain = queue.enqueue({ tool: "shell", args: { cmd: "ls" }, riskTier: "risky", why: "   " });
    expect(plain.rule).toBeNull();
    expect(plain.picture).toBe(false);
    expect(plain.why).toBeNull();
    expect(queue.pictureOf(plain.id)).toBeUndefined();
    // Listing says there is a picture without carrying it.
    expect(queue.pending().map((a) => a.picture)).toEqual([true, false]);

    // A workspace from before: the table without the two columns.
    ws.db.exec(`DROP TABLE pending_actions`);
    ws.db.exec(`CREATE TABLE pending_actions (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, risk_tier TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', user_id TEXT, conversation_id TEXT, requested_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT)`);
    ws.db.exec(`INSERT INTO pending_actions (tool, args, risk_tier, requested_at) VALUES ('shell', '{}', 'risky', 1)`);
    const older = new ApprovalQueue(ws.db);
    expect(older.pending()).toHaveLength(1);
    expect(older.pending()[0]).toMatchObject({ tool: "shell", rule: null, picture: false, why: null, owner: false, attended: false });
  });

  it("keeps who the asking turn was, and reads a row from before as nobody's", () => {
    const mine = queue.enqueue({ tool: "files.rm", args: { path: "x" }, riskTier: "risky", owner: true, attended: true });
    const theirs = queue.enqueue({ tool: "files.rm", args: { path: "y" }, riskTier: "risky", attended: true });
    expect(queue.get(mine.id)).toMatchObject({ owner: true, attended: true });
    expect(queue.get(theirs.id)).toMatchObject({ owner: false, attended: true });

    // A table from before the two columns, with a row waiting in it.
    ws.db.exec(`DROP TABLE pending_actions`);
    ws.db.exec(`CREATE TABLE pending_actions (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, risk_tier TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', user_id TEXT, conversation_id TEXT, requested_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, rule TEXT, picture TEXT, why TEXT)`);
    ws.db.exec(`INSERT INTO pending_actions (tool, args, risk_tier, requested_at) VALUES ('files.rm', '{}', 'risky', 1)`);
    const older = new ApprovalQueue(ws.db);
    expect(older.pending()[0]).toMatchObject({ tool: "files.rm", owner: false, attended: false, waits: false });
    // Migrated once: opening it again neither fails nor changes the row.
    const again = new ApprovalQueue(ws.db);
    expect(again.pending()[0]).toMatchObject({ owner: false, attended: false });
    expect(again.enqueue({ tool: "shell", args: {}, riskTier: "risky", owner: true, attended: true })).toMatchObject({ owner: true, attended: true });
  });

  it("lapses a held turn's ask with the approval window and an ask nothing waits on with the inbox's hours", () => {
    const windows = { approvalMinutes: 30, approvalExpiryHours: 24 };
    // An unattended turn that waits (a resumed chat, a dispatch) is still a turn holding for the answer.
    const held = queue.enqueue({ tool: "files.rm", args: { path: "x" }, riskTier: "risky", attended: false, waits: true });
    // A schedule that only queues, though the owner may be watching its thread.
    const queued = queue.enqueue({ tool: "files.rm", args: { path: "y" }, riskTier: "risky", attended: true });
    expect(queue.get(held.id)?.waits).toBe(true);
    expect(approvalExpiry(queue.get(held.id)!, windows)).toBe(held.requestedAt + 30 * 60_000);
    expect(approvalExpiry(queue.get(queued.id)!, windows)).toBe(queued.requestedAt + 24 * 3_600_000);
  });

  it("keeps what was decided, newest first", () => {
    const a = queue.enqueue({ tool: "cron.run", args: { id: 1 }, riskTier: "risky", reason: "runs it" });
    const b = queue.enqueue({ tool: "files.rm", args: { path: "x" }, riskTier: "risky", reason: "outside" });
    queue.enqueue({ tool: "shell", args: {}, riskTier: "risky", reason: "waits" });
    queue.deny(a.id, "owner");
    queue.approve(b.id, "owner");
    expect(queue.decided().map((r) => [r.id, r.status])).toEqual([
      [b.id, "approved"],
      [a.id, "denied"],
    ]);
    expect(queue.decided({ limit: 1 }).map((r) => r.id)).toEqual([b.id]);
  });

  describe("the decided history, a page at a time", () => {
    let clock = 1_000;
    beforeEach(() => {
      clock = 1_000;
      queue = new ApprovalQueue(ws.db, undefined, () => (clock += 1_000));
    });

    function decideMany(): number[] {
      const ids: number[] = [];
      for (let i = 0; i < 7; i++) {
        const a = queue.enqueue({ tool: i % 2 ? "files.rm" : "cron.run", args: { path: `file-${i}.txt` }, riskTier: "risky", ...(i === 3 ? { reason: "outside the scratch folder" } : {}), picture: "A".repeat(100) });
        if (i % 3 === 2) queue.deny(a.id, "owner");
        else if (i === 6) queue.lapse(a.id, "timeout");
        else queue.approve(a.id, "owner");
        ids.push(a.id);
      }
      queue.enqueue({ tool: "still.waiting", args: {}, riskTier: "risky" });
      return ids.reverse();
    }

    it("continues after the last row of the page before, newest first", () => {
      const ids = decideMany();
      const first = queue.decided({ limit: 3 });
      expect(first.map((r) => r.id)).toEqual(ids.slice(0, 3));
      const last = first.at(-1)!;
      const next = queue.decided({ limit: 3, before: { decidedAt: last.decidedAt!, id: last.id } });
      expect(next.map((r) => r.id)).toEqual(ids.slice(3, 6));
      expect(queue.decided({ limit: 10 }).map((r) => r.id)).toEqual(ids);
    });

    it("holds a page to one outcome or a few words, and never reads the picture", () => {
      decideMany();
      expect(queue.decided({ status: "denied" }).every((r) => r.status === "denied")).toBe(true);
      expect(queue.decided({ status: "denied" })).toHaveLength(2);
      expect(queue.decided({ q: "file-4" }).map((r) => r.args)).toEqual([JSON.stringify({ path: "file-4.txt" })]);
      expect(queue.decided({ q: "scratch folder" })).toHaveLength(1);
      // A LIKE wildcard is a character to look for, not a wildcard.
      expect(queue.decided({ q: "%" })).toHaveLength(0);
      const row = queue.decided({ limit: 1 })[0]!;
      expect(row.picture).toBe(true);
      expect(Object.values(row)).not.toContain("A".repeat(100));
    });

    it("counts by outcome and marks the latest, so a reader knows when to look again", () => {
      const ids = decideMany();
      expect(queue.decidedCounts()).toEqual({ approved: 4, denied: 2, expired: 1 });
      expect(queue.decidedMark()).toEqual({ total: 7, latest: ids[0] });
    });
  });

  it("indexes the decided history, on a workspace from before too", () => {
    ws.db.exec(`DROP INDEX IF EXISTS pending_actions_status_decided`);
    new ApprovalQueue(ws.db);
    const index = ws.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'pending_actions_status_decided'`).get() as { sql: string } | undefined;
    expect(index?.sql).toContain("(status, decided_at, id)");
    const plan = ws.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM pending_actions WHERE status = 'denied' ORDER BY decided_at DESC, id DESC LIMIT 5`).all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("pending_actions_status_decided");
  });

  it("approves and denies, leaving the queue clear", () => {
    const a = queue.enqueue({ tool: "t", args: {}, riskTier: "risky" });
    const approved = queue.approve(a.id, "owner");
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedBy).toBe("owner");
    expect(queue.pending()).toHaveLength(0);
  });

  it("lapses an awaited ask when the wait runs out, so the row and every prompt settle", async () => {
    const told: string[] = [];
    queue.onDecided((a) => told.push(`${a.id}:${a.status}:${a.decidedBy ?? ""}`));
    const a = queue.enqueue({ tool: "shell", args: { cmd: "rm x" }, riskTier: "risky" });
    expect(await queue.waitFor(a.id, 5)).toBe("expired");
    expect(queue.get(a.id)?.status).toBe("expired");
    expect(queue.pending()).toHaveLength(0);
    expect(told).toEqual([`${a.id}:expired:timeout`]);
    // Lapsed is decided: the owner's late click lands on nothing.
    expect(queue.approve(a.id, "owner")).toBeUndefined();
    // A decision that lands first stands, and the waiter hears it.
    const b = queue.enqueue({ tool: "shell", args: { cmd: "rm y" }, riskTier: "risky" });
    const waited = queue.waitFor(b.id, 50);
    queue.approve(b.id, "owner");
    expect(await waited).toBe("approved");
  });

  it("expires the asks nobody is waiting on once they are old enough", () => {
    let clock = 1_000_000;
    const q = new ApprovalQueue(ws.db, undefined, () => clock);
    const old = q.enqueue({ tool: "shell", args: { cmd: "a" }, riskTier: "risky" });
    clock += 2 * 3_600_000;
    const fresh = q.enqueue({ tool: "shell", args: { cmd: "b" }, riskTier: "risky" });
    clock += 30 * 60_000;
    expect(q.expire(3_600_000).map((x) => x.id)).toEqual([old.id]);
    expect(q.get(old.id)).toMatchObject({ status: "expired", decidedBy: "timeout" });
    expect(q.pending().map((x) => x.id)).toEqual([fresh.id]);
    expect(q.expire(3_600_000)).toEqual([]);
  });

  it("does not re-decide an already-decided action", () => {
    const a = queue.enqueue({ tool: "t", args: {}, riskTier: "risky" });
    expect(queue.approve(a.id, "owner")?.status).toBe("approved");
    expect(queue.deny(a.id, "owner")).toBeUndefined();
    expect(queue.get(a.id)?.status).toBe("approved");
  });

  it("redacts secret values in stored args", () => {
    const secrets = new SecretsRegistry({ stripe: "sk-live-xyz" });
    const q = new ApprovalQueue(ws.db, secrets);
    const a = q.enqueue({
      tool: "http.fetch",
      args: { auth: "sk-live-xyz" },
      riskTier: "risky",
    });
    expect(a.args).not.toContain("sk-live-xyz");
    expect(a.args).toContain("{{secret:stripe}}");
  });
});

describe("gateToolCall", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let queue: ApprovalQueue;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-gate-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    queue = new ApprovalQueue(ws.db);
    registry.register(
      { name: "read", description: "safe", inputSchema: { type: "object" } },
      () => "ok",
    );
    registry.register(
      { name: "shell", description: "risky", inputSchema: { type: "object" } },
      () => "ran",
      RISKY,
    );
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a safe tool immediately", () => {
    const decision = gateToolCall(registry, queue, "read", {});
    expect(decision).toEqual({ decision: "run", riskTier: "safe" });
    expect(queue.pending()).toHaveLength(0);
  });

  it("queues a risky tool for approval", () => {
    const decision = gateToolCall(registry, queue, "shell", { cmd: "x" });
    expect(decision.decision).toBe("queued");
    expect(queue.pending()).toHaveLength(1);
  });
});
