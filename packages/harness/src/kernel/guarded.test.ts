import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { AuditLog } from "../ops/audit.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { PermissionStore } from "../ops/permissions.js";
import { RISKY } from "../risk/tiers.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { caller } from "./caller.js";
import { GuardedTools, type GuardedToolsDeps } from "./guarded.js";

describe("GuardedTools", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let audit: AuditLog;
  let approvals: ApprovalQueue;
  let secrets: SecretsRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-guarded-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    audit = new AuditLog(ws.db);
    approvals = new ApprovalQueue(ws.db);
    secrets = new SecretsRegistry({ openai: "sk-real" });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  function guarded(over: Partial<GuardedToolsDeps> = {}): GuardedTools {
    return new GuardedTools({ registry, secrets, audit, approvals, ...over });
  }

  it("runs a risky call the owner already decided, without asking", async () => {
    /*
     * 96 of 97 approvals on a real workspace were granted. A decision made
     * for this shape is not asked again: the call runs, audited as risky,
     * and nothing reaches the queue. A shape with no rule still queues.
     */
    registry.register({ name: "danger", description: "d", inputSchema: { type: "object" } }, () => "done", { floor: "risky" });
    const permissions = new PermissionStore(ws.db);
    const tools = guarded({ permissions, projectSlug: () => undefined, waitForApproval: false });

    const asked = await tools.execute("danger", { x: 1 });
    expect(asked.content).toMatch(/Queued for approval/);
    expect(approvals.pending()).toHaveLength(1);

    permissions.add({ tool: "danger", scope: null, project: null });
    const ran = await tools.execute("danger", { x: 1 });
    expect(ran.content).toBe("done");
    expect(approvals.pending()).toHaveLength(1);
    expect(audit.recent(1)[0]).toMatchObject({ tool: "danger", riskTier: "risky" });
  });

  it("tells a handler which conversation is calling, per call, under concurrency", async () => {
    /*
     * Turns run one lane per conversation, so two toolboxes execute at once.
     * A handler that asks who is calling must get its own conversation, not
     * whichever turn happened to start last: an aside running beside an
     * orchestrator turn once took credit for that turn's congregation roster.
     */
    registry.register(
      { name: "whoami", description: "w", inputSchema: { type: "object" } },
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return caller.getStore() ?? "nobody";
      },
      { floor: "safe" },
    );
    const a = guarded({ conversationId: "aside:primary" });
    const b = guarded({ conversationId: "orchestrator:owner" });
    const anon = guarded();

    const [ra, rb, rn] = await Promise.all([
      a.execute("whoami", {}),
      b.execute("whoami", {}),
      anon.execute("whoami", {}),
    ]);
    expect(ra.content).toBe("aside:primary");
    expect(rb.content).toBe("orchestrator:owner");
    expect(rn.content).toBe("nobody");
    // Nothing leaks out of a call: outside any handler there is no caller.
    expect(caller.getStore()).toBeUndefined();
  });

  it("runs a safe tool, injecting secrets and auditing", async () => {
    let seen: string | undefined;
    registry.register(
      { name: "echo", description: "e", inputSchema: { type: "object" } },
      (input) => {
        seen = String(input.key);
        return "ok";
      },
    );
    const res = await guarded().execute("echo", { key: "{{secret:openai}}" });
    expect(res.isError).toBe(false);
    expect(seen).toBe("sk-real"); // injected before execution
    const [entry] = audit.recent();
    expect(entry?.tool).toBe("echo");
    expect(entry?.args).toContain("{{secret:openai}}"); // audit stays redacted
  });

  it("holds a risky call until the owner decides, then runs it", async () => {
    let ran = false;
    registry.register(
      { name: "danger", description: "d", inputSchema: { type: "object" } },
      () => {
        ran = true;
        return "ran";
      },
      RISKY,
    );

    // The call does not return while it waits: the turn is suspended inside
    // it. Returning early is what used to end the turn and start a second one
    // on approval, which cleared the live view and ran the tool under a new
    // bubble.
    const call = guarded().execute("danger", {});
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    expect(ran).toBe(false);

    approvals.approve(approvals.pending()[0]!.id, "owner");
    const res = await call;

    expect(ran).toBe(true);
    expect(res.content).toBe("ran");
    expect(res.isError).toBeFalsy();
  });

  it("does not run it when the owner says no", async () => {
    registry.register(
      { name: "danger", description: "d", inputSchema: { type: "object" } },
      () => "ran",
      RISKY,
    );
    const call = guarded().execute("danger", {});
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));

    approvals.deny(approvals.pending()[0]!.id, "owner");
    const res = await call;

    // Told plainly, and told not to try again: a refusal the model reads as a
    // transient failure is a refusal it will work around.
    expect(res.content).toMatch(/not approved/);
    expect(res.content).toMatch(/Do not try it again/);
  });

  it("treats silence as a refusal rather than waiting forever", async () => {
    registry.register(
      { name: "danger", description: "d", inputSchema: { type: "object" } },
      () => "ran",
      RISKY,
    );
    // A turn that waits forever holds its conversation's queue forever.
    const res = await guarded({ approvalTimeoutMs: 10 }).execute("danger", {});
    expect(res.content).toMatch(/not approved/);
  });


  it("offers a project's tools only inside that project", async () => {
    // A module for the pantry project: its tool exists in pantry's
    // conversations and nowhere else, withheld rather than hidden.
    registry.register(
      { name: "mcp.shelf.count", description: "count", inputSchema: { type: "object", properties: {} } },
      () => "3",
      { floor: "safe" },
      { tags: ["project:pantry"] },
    );
    const inside = guarded({ projectSlug: () => "pantry" });
    const outside = guarded({ projectSlug: () => "garden" });
    const root = guarded({ projectSlug: () => undefined });
    expect(inside.defs().map((d) => d.name)).toContain("mcp.shelf.count");
    expect(outside.defs().map((d) => d.name)).not.toContain("mcp.shelf.count");
    expect(root.defs().map((d) => d.name)).not.toContain("mcp.shelf.count");
    expect((await outside.execute("mcp.shelf.count", {})).isError).toBe(true);
    expect((await inside.execute("mcp.shelf.count", {})).content).toBe("3");
  });
});


describe("repeated calls", () => {
  let root: string;
  let ws: Workspace;
  let tools: GuardedTools;
  let calls: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-repeat-"));
    ws = Workspace.open(root);
    calls = 0;
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "peek",
        description: "read something",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      () => {
        calls += 1;
        return "same answer";
      },
      { floor: "safe" },
    );
    tools = new GuardedTools({
      registry,
      secrets: new SecretsRegistry(),
      audit: new AuditLog(ws.db),
      approvals: new ApprovalQueue(ws.db),
    });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a third identical call and says why", async () => {
    // A scoped agent spent its whole step budget calling one tool with one set
    // of arguments over and over, and the turn ended with no answer at all.
    expect((await tools.execute("peek", { q: "x" })).isError).toBe(false);
    expect((await tools.execute("peek", { q: "x" })).isError).toBe(false);
    const third = await tools.execute("peek", { q: "x" });
    expect(third.isError).toBe(true);
    expect(third.content).toMatch(/already called peek/);
    expect(calls).toBe(2);
  });

  it("counts arguments, not just the tool", async () => {
    await tools.execute("peek", { q: "x" });
    await tools.execute("peek", { q: "x" });
    const other = await tools.execute("peek", { q: "y" });
    expect(other.isError).toBe(false);
    expect(other.content).toBe("same answer");
  });

  it("starts fresh for the next turn", async () => {
    await tools.execute("peek", { q: "x" });
    await tools.execute("peek", { q: "x" });
    expect((await tools.execute("peek", { q: "x" })).isError).toBe(true);
    // A GuardedTools instance is built per turn, so a new one forgets.
    const next = new GuardedTools({
      registry: (tools as unknown as { deps: { registry: ToolRegistry } }).deps
        .registry,
      secrets: new SecretsRegistry(),
      audit: new AuditLog(ws.db),
      approvals: new ApprovalQueue(ws.db),
    });
    expect((await next.execute("peek", { q: "x" })).isError).toBe(false);
  });
});
