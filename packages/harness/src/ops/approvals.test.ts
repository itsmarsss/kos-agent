import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { RISKY } from "../risk/tiers.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { ApprovalQueue, gateToolCall } from "./approvals.js";

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
    expect(older.pending()[0]).toMatchObject({ tool: "shell", rule: null, picture: false, why: null });
  });

  it("keeps what was decided, newest first", () => {
    const a = queue.enqueue({ tool: "cron.run", args: { id: 1 }, riskTier: "risky", reason: "runs it" });
    const b = queue.enqueue({ tool: "files.rm", args: { path: "x" }, riskTier: "risky", reason: "outside" });
    queue.enqueue({ tool: "shell", args: {}, riskTier: "risky", reason: "waits" });
    queue.deny(a.id, "owner");
    queue.approve(b.id, "owner");
    expect(queue.recent().map((r) => [r.id, r.status])).toEqual([
      [b.id, "approved"],
      [a.id, "denied"],
    ]);
    expect(queue.recent(1).map((r) => r.id)).toEqual([b.id]);
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
