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
import { GuardedTools } from "./guarded.js";

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
