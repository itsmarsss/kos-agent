import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { Migrator, buildMigrationSql } from "./migrate.js";

describe("buildMigrationSql", () => {
  it("builds a namespaced create_table", () => {
    const sql = buildMigrationSql("budget", {
      op: "create_table",
      table: "tx",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "amount", type: "REAL", notNull: true, default: 0 },
        { name: "note", type: "TEXT" },
      ],
    });
    expect(sql).toBe(
      "CREATE TABLE budget_tx (id INTEGER PRIMARY KEY, amount REAL NOT NULL DEFAULT 0, note TEXT)",
    );
  });

  it("quotes string defaults safely", () => {
    const sql = buildMigrationSql("p", {
      op: "add_column",
      table: "t",
      column: { name: "label", type: "TEXT", default: "it's fine" },
    });
    expect(sql).toBe("ALTER TABLE p_t ADD COLUMN label TEXT DEFAULT 'it''s fine'");
  });

  it("builds rename and index DDL", () => {
    expect(
      buildMigrationSql("p", { op: "rename_table", from: "old", to: "new" }),
    ).toBe("ALTER TABLE p_old RENAME TO p_new");
    expect(
      buildMigrationSql("p", {
        op: "create_index",
        table: "tx",
        columns: ["date", "amount"],
        unique: true,
      }),
    ).toBe("CREATE UNIQUE INDEX p_tx_date_amount_idx ON p_tx (date, amount)");
  });

  it("rejects unsafe identifiers and bad types", () => {
    expect(() =>
      buildMigrationSql("p", {
        op: "create_table",
        table: "tx; DROP TABLE secrets",
        columns: [{ name: "id", type: "INTEGER" }],
      }),
    ).toThrow(/invalid/);
    expect(() =>
      buildMigrationSql("p", {
        op: "create_table",
        table: "tx",
        columns: [{ name: "x", type: "VARCHAR" }],
      }),
    ).toThrow(/unsupported column type/);
  });
});

describe("Migrator", () => {
  let root: string;
  let ws: Workspace;
  let manifest: ProjectManifest;
  let migrator: Migrator;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-migrate-"));
    ws = Workspace.open(root);
    manifest = new ProjectManifest(ws.db);
    migrator = new Migrator(ws.db, manifest);
    manifest.createProject({ name: "Budget", type: "budget" });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("applies a migration, creating the real table", () => {
    const rec = migrator.migrate("budget", {
      op: "create_table",
      table: "tx",
      columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
    });
    expect(rec.version).toBe(1);
    // the namespaced table now exists and is usable
    ws.db.prepare("INSERT INTO budget_tx (id) VALUES (1)").run();
    const row = ws.db.prepare("SELECT id FROM budget_tx").get() as { id: number };
    expect(row.id).toBe(1);
  });

  it("increments version and records history", () => {
    migrator.migrate("budget", {
      op: "create_table",
      table: "tx",
      columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
    });
    migrator.migrate("budget", {
      op: "add_column",
      table: "tx",
      column: { name: "amount", type: "REAL" },
    });
    const history = migrator.history("budget");
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect(history[1]?.op).toBe("add_column");
  });

  it("rejects migrations to an unknown project", () => {
    expect(() =>
      migrator.migrate("ghost", {
        op: "create_table",
        table: "t",
        columns: [{ name: "id", type: "INTEGER" }],
      }),
    ).toThrow(/unknown project/);
  });

  it("rolls back and records nothing when the DDL fails", () => {
    expect(() =>
      migrator.migrate("budget", {
        op: "add_column",
        table: "missing",
        column: { name: "x", type: "TEXT" },
      }),
    ).toThrow();
    expect(migrator.history("budget")).toEqual([]);
  });
});
