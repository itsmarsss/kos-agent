import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { openDatabase } from "../store/db.js";
import { Migrator, buildMigrationSql, parseChangeSpec } from "./migrate.js";

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

describe("parseChangeSpec", () => {
  it("accepts a well-formed create_table", () => {
    expect(
      parseChangeSpec({
        op: "create_table",
        table: "tx",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "amount", type: "REAL" },
        ],
      }),
    ).toEqual({
      op: "create_table",
      table: "tx",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "amount", type: "REAL" },
      ],
    });
  });

  it("names the missing field and the keys it did get", () => {
    // The model guessed "fields". Reading spec.columns.length threw a
    // TypeError that named nothing, so it retried the same shape four times.
    let message = "";
    try {
      parseChangeSpec({
        op: "create_table",
        table: "expenses",
        fields: [{ name: "id", type: "serial" }],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('requires "columns"');
    expect(message).toContain("fields");
    expect(message).not.toContain("Cannot read properties");
  });

  it("lists the allowed types when given one SQLite does not have", () => {
    expect(() =>
      parseChangeSpec({
        op: "create_table",
        table: "tx",
        columns: [{ name: "amount", type: "decimal(10,2)" }],
      }),
    ).toThrow(/TEXT, INTEGER, REAL, BLOB, NUMERIC/);
  });

  it("rejects an unknown op by listing the real ones", () => {
    expect(() => parseChangeSpec({ op: "drop_table", table: "tx" })).toThrow(
      /create_table, add_column/,
    );
  });

  it("rejects a spec that is not an object", () => {
    expect(() => parseChangeSpec("create_table")).toThrow(/must be an object/);
  });
});

describe("re-creating a table", () => {
  let root: string;
  let ws: Workspace;
  let migrator: Migrator;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-remigrate-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Budget Tracker", type: "budget" });
    migrator = new Migrator(ws.db, manifest);
    migrator.migrate("budget_tracker", {
      op: "create_table",
      table: "expenses",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "amount", type: "REAL" },
      ],
    });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("says what the table already holds", () => {
    // "table X already exists" sent the agent looking through PRAGMA and grep
    // for the columns, which are right there.
    expect(() =>
      migrator.migrate("budget_tracker", {
        op: "create_table",
        table: "expenses",
        columns: [{ name: "id", type: "INTEGER" }],
      }),
    ).toThrow(/already exists with columns: id, amount\. Use add_column/);
  });

  it("records nothing for the refused migration", () => {
    try {
      migrator.migrate("budget_tracker", {
        op: "create_table",
        table: "expenses",
        columns: [{ name: "id", type: "INTEGER" }],
      });
    } catch {
      // expected
    }
    expect(migrator.history("budget_tracker")).toHaveLength(1);
  });
});

/**
 * A NOT NULL column with no default is a column only the agent can fill.
 *
 * The tasks module's items table declared created_at NOT NULL, so its own
 * generated page could not insert a row: adding a task through the checklist
 * failed with "NOT NULL constraint failed". Any agent-authored table with a
 * created_at and a form hits the same wall, so the fix belongs here rather
 * than in that one module.
 */
describe("computed defaults", () => {
  it("renders a now default as an expression, not a string", () => {
    const sql = buildMigrationSql("p", {
      op: "create_table",
      table: "notes",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "created_at", type: "INTEGER", notNull: true, default: { expr: "now" } },
      ],
    });
    expect(sql).toContain("DEFAULT (");
    // Quoted, it would be the four-character string "now" in an INTEGER
    // column, which is the bug this shape exists to avoid.
    expect(sql).not.toContain("DEFAULT 'now'");
  });

  it("actually fills the column on insert", () => {
    const db = openDatabase(":memory:");
    db.exec(
      buildMigrationSql("p", {
        op: "create_table",
        table: "notes",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "title", type: "TEXT", notNull: true },
          {
            name: "created_at",
            type: "INTEGER",
            notNull: true,
            default: { expr: "now" },
          },
        ],
      }),
    );
    db.prepare(`INSERT INTO p_notes (title) VALUES ('hi')`).run();
    const row = db.prepare(`SELECT created_at FROM p_notes`).get() as {
      created_at: number;
    };
    // Milliseconds, matching what the rest of KOS stores.
    expect(row.created_at).toBeGreaterThan(1e12);
    expect(Math.abs(row.created_at - Date.now())).toBeLessThan(60_000);
  });

  it("refuses an expression it does not know in an agent-written spec", () => {
    expect(() =>
      parseChangeSpec({
        op: "create_table",
        table: "t",
        columns: [
          { name: "c", type: "TEXT", default: { expr: "(SELECT k FROM keys)" } },
        ],
      }),
    ).toThrow(/literal or one of/);
  });

  it("keeps accepting ordinary literal defaults", () => {
    const spec = parseChangeSpec({
      op: "create_table",
      table: "t",
      columns: [
        { name: "a", type: "INTEGER", default: 0 },
        { name: "b", type: "TEXT", default: "hi" },
        { name: "c", type: "TEXT", default: null },
      ],
    });
    expect(spec).toMatchObject({
      columns: [{ default: 0 }, { default: "hi" }, { default: null }],
    });
  });

  it("refuses an expression it does not know", () => {
    expect(() =>
      buildMigrationSql("p", {
        op: "create_table",
        table: "t",
        columns: [
          {
            name: "c",
            type: "TEXT",
            // The whole point of a closed vocabulary: anything else is SQL
            // arriving from a place SQL should not arrive from.
            default: { expr: "(SELECT secret FROM keys)" } as never,
          },
        ],
      }),
    ).toThrow();
  });
});
