import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { AuditLog } from "../ops/audit.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { RISKY } from "../risk/tiers.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
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

  function guarded(): GuardedTools {
    return new GuardedTools({ registry, secrets, audit, approvals });
  }

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

  it("queues a risky tool for approval and does not execute it", async () => {
    let ran = false;
    registry.register(
      { name: "danger", description: "d", inputSchema: { type: "object" } },
      () => {
        ran = true;
        return "ran";
      },
      RISKY,
    );
    const res = await guarded().execute("danger", {});
    expect(ran).toBe(false);
    expect(res.content).toMatch(/queued for approval/);
    expect(approvals.pending()).toHaveLength(1);
  });

  it("offers only scoped tools to the model", () => {
    registry.register(
      { name: "global", description: "g", inputSchema: { type: "object" } },
      () => "x",
    );
    registry.register(
      { name: "budget.add", description: "b", inputSchema: { type: "object" } },
      () => "x",
      undefined,
      { tags: ["budget"] },
    );
    const scoped = new GuardedTools({
      registry,
      secrets,
      audit,
      approvals,
      scopeTags: ["budget"],
    });
    expect(scoped.defs().map((d) => d.name).sort()).toEqual([
      "budget.add",
      "global",
    ]);
  });
});

describe("GuardedTools tool scoping", () => {
  function registryWith(count: number): ToolRegistry {
    const registry = new ToolRegistry();
    for (let i = 0; i < count; i++) {
      registry.register(
        { name: `t${i}`, description: "d", inputSchema: { type: "object" } },
        () => "ok",
        { floor: "safe" },
        // Tag every tool so scoping would narrow hard if it engaged.
        { tags: [i % 2 === 0 ? "even" : "odd"] },
      );
    }
    return registry;
  }

  function guarded(registry: ToolRegistry, opts: Partial<GuardedToolsDeps> = {}) {
    return new GuardedTools({
      registry,
      secrets: new SecretsRegistry(),
      audit: { record: () => undefined } as unknown as AuditLog,
      approvals: { enqueue: () => ({ id: 1 }) } as unknown as ApprovalQueue,
      ...opts,
    } as GuardedToolsDeps);
  }

  it("does not narrow while every tool fits under the cap", () => {
    // The flicker: scope inferred from one message would drop half the tools
    // on a follow-up that happened to match a different keyword.
    const registry = registryWith(10);
    const defs = guarded(registry, { toolLimit: 48, scopeTags: ["even"] }).defs();
    expect(defs).toHaveLength(10);
  });

  it("narrows by tag once the registry exceeds the cap", () => {
    const registry = registryWith(20);
    const defs = guarded(registry, { toolLimit: 8, scopeTags: ["even"] }).defs();
    expect(defs.length).toBeLessThanOrEqual(8);
    expect(defs.every((d) => Number(d.name.slice(1)) % 2 === 0)).toBe(true);
  });

  it("offers everything when no scope is active", () => {
    const registry = registryWith(5);
    expect(guarded(registry).defs()).toHaveLength(5);
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
