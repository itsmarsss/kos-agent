import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { caller } from "../kernel/caller.js";
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

  it("keeps whose turn made a call: as said, else the calling turn's, on an older table too", () => {
    ws.db.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, result TEXT NOT NULL, is_error INTEGER NOT NULL, risk_tier TEXT, user_id TEXT, created_at INTEGER NOT NULL)");
    const log = new AuditLog(ws.db);
    const said = log.record({ tool: "files.write", args: {}, result: "ok", isError: false, conversationId: "c1" });
    const called = caller.run("c2", () => log.record({ tool: "files.write", args: {}, result: "ok", isError: false }));
    const none = log.record({ tool: "files.write", args: {}, result: "ok", isError: false });
    expect([said, called, none].map((id) => log.get(id)?.conversationId)).toEqual(["c1", "c2", null]);
  });

  it("keeps where the yes that ran a call came from, and reads an older table's rows as unknown", () => {
    ws.db.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, result TEXT NOT NULL, is_error INTEGER NOT NULL, risk_tier TEXT, user_id TEXT, created_at INTEGER NOT NULL, conversation_id TEXT, approved_by TEXT)");
    ws.db.exec("INSERT INTO audit_log (tool, args, result, is_error, risk_tier, created_at) VALUES ('sql', '{}', 'deleted', 0, 'risky', 1)");
    const log = new AuditLog(ws.db);
    expect(log.recent()[0]).toMatchObject({ tool: "sql", decidedVia: null, approvalId: null });
    const ran = log.record({ tool: "sql", args: {}, result: "deleted", isError: false, riskTier: "risky", decidedVia: "discord", approvalId: 742 });
    expect(log.get(ran)).toMatchObject({ decidedVia: "discord", approvalId: 742 });
  });

  it("tallies one chat's calls after a mark, with the first that failed", () => {
    const log = new AuditLog(ws.db);
    log.record({ tool: "files.read", args: {}, result: "old", isError: true, conversationId: "c1" });
    const mark = log.lastId();
    log.record({ tool: "files.ls", args: {}, result: "ok", isError: false, conversationId: "c1" });
    log.record({ tool: "files.read", args: {}, result: "ENOENT", isError: true, conversationId: "c1" });
    log.record({ tool: "files.read", args: {}, result: "other chat", isError: true, conversationId: "c2" });
    expect(log.tally("c1", mark)).toEqual({ total: 2, failed: 1, firstError: "files.read: ENOENT" });
    expect(log.tally("c3", 0)).toEqual({ total: 0, failed: 0, firstError: null });
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
