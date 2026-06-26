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

  it("approves and denies, leaving the queue clear", () => {
    const a = queue.enqueue({ tool: "t", args: {}, riskTier: "risky" });
    const approved = queue.approve(a.id, "owner");
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedBy).toBe("owner");
    expect(queue.pending()).toHaveLength(0);
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
