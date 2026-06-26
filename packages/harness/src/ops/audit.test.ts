import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { AuditLog } from "./audit.js";

describe("AuditLog", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-audit-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("records tool calls and returns them newest-first", () => {
    const log = new AuditLog(ws.db);
    log.record({ tool: "notify", args: { text: "a" }, result: "ok", isError: false });
    log.record({ tool: "sql", args: { q: "SELECT 1" }, result: "1", isError: false });
    const recent = log.recent();
    expect(recent.map((r) => r.tool)).toEqual(["sql", "notify"]);
  });

  it("redacts secret values in args and result", () => {
    const secrets = new SecretsRegistry({ openai: "sk-secret-123" });
    const log = new AuditLog(ws.db, secrets);
    log.record({
      tool: "http.fetch",
      args: { auth: "sk-secret-123" },
      result: "used sk-secret-123 ok",
      isError: false,
    });
    const [rec] = log.recent();
    expect(rec?.args).not.toContain("sk-secret-123");
    expect(rec?.args).toContain("{{secret:openai}}");
    expect(rec?.result).toContain("{{secret:openai}}");
  });

  it("preserves error flag and risk tier", () => {
    const log = new AuditLog(ws.db);
    log.record({
      tool: "shell",
      args: {},
      result: "boom",
      isError: true,
      riskTier: "risky",
    });
    const [rec] = log.recent();
    expect(rec?.isError).toBe(true);
    expect(rec?.riskTier).toBe("risky");
  });
});
