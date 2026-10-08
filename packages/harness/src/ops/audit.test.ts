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

  it("counts calls and errors by the hour, oldest first", () => {
    const hour = 3_600_000;
    let now = 10 * hour + 5;
    const log = new AuditLog(ws.db, undefined, () => now);
    log.record({ tool: "a", args: {}, result: "ok", isError: false });
    now = 10 * hour + 900_000;
    log.record({ tool: "b", args: {}, result: "no", isError: true });
    now = 12 * hour;
    log.record({ tool: "c", args: {}, result: "ok", isError: false });
    expect(log.byHour(0)).toEqual([
      { hour: 10 * hour, calls: 2, errors: 1 },
      { hour: 12 * hour, calls: 1, errors: 0 },
    ]);
    // Since a moment: the earlier hour is left out, not truncated.
    expect(log.byHour(11 * hour)).toEqual([{ hour: 12 * hour, calls: 1, errors: 0 }]);
  });
});

/**
 * What has KOS actually done to this project?
 *
 * The project drawer could say what a project contains but nothing about what
 * had happened to it, which is the question you open a drawer to ask when a
 * tracker looks wrong.
 */
describe("AuditLog.touching", () => {
  let root: string;
  let ws: Workspace;
  let log: AuditLog;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-audit-touch-"));
    ws = Workspace.open(root);
    log = new AuditLog(ws.db, new SecretsRegistry());
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  function record(tool: string, args: Record<string, unknown>): void {
    log.record({ tool, args, result: "ok", isError: false });
  }

  it("finds calls that name the project in their arguments", () => {
    record("sql.query", { sql: "SELECT * FROM kitchen_redo_items" });
    record("pages.write", { project: "kitchen_redo", spec: {} });
    record("files.read", { path: "notes.md" });

    const rows = log.touching("kitchen_redo");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tool)).toEqual(["pages.write", "sql.query"]);
  });

  it("does not treat the underscore in a slug as a wildcard", () => {
    // LIKE reads _ as "any character", so a slug match written with LIKE
    // silently matches the wrong projects. This bit once already.
    record("sql.query", { sql: "SELECT * FROM kitchenXredo_items" });
    expect(log.touching("kitchen_redo")).toHaveLength(0);
  });

  it("newest first, and bounded", () => {
    for (let i = 0; i < 30; i++) record("sql.query", { t: `trip_prep_${i}` });
    const rows = log.touching("trip_prep", 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.args).toContain("trip_prep_29");
  });

  it("returns nothing for a project nothing has touched", () => {
    record("files.read", { path: "notes.md" });
    expect(log.touching("nothing_here")).toEqual([]);
  });
});
