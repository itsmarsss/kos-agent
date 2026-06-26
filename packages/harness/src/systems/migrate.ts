import type { Db } from "../store/db.js";
import { assertIdentifier, projectTable } from "./identifiers.js";
import type { ProjectManifest } from "./manifest.js";

/**
 * Guarded schema evolution. The agent never issues raw DDL; it declares a
 * structured changeSpec, and the harness validates identifiers, namespaces
 * tables to the project slug, builds the DDL, runs it in a transaction, and
 * records it in a per-project schema_migrations log. Rollback is git-snapshot
 * restore of the DB file (not reverse DDL); this log is the visible history.
 */

const COLUMN_TYPES = new Set(["TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC"]);

export interface ColumnDef {
  name: string;
  type: string;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null;
}

export type ChangeSpec =
  | { op: "create_table"; table: string; columns: ColumnDef[] }
  | { op: "add_column"; table: string; column: ColumnDef }
  | { op: "drop_column"; table: string; column: string }
  | { op: "rename_column"; table: string; from: string; to: string }
  | { op: "rename_table"; from: string; to: string }
  | {
      op: "create_index";
      table: string;
      columns: string[];
      unique?: boolean;
      name?: string;
    };

export interface MigrationRecord {
  id: number;
  projectSlug: string;
  version: number;
  op: string;
  spec: ChangeSpec;
  sql: string;
  appliedAt: number;
}

function normalizeType(type: string): string {
  const t = type.toUpperCase();
  if (!COLUMN_TYPES.has(t)) {
    throw new Error(
      `unsupported column type: ${JSON.stringify(type)} (allowed: ${[...COLUMN_TYPES].join(", ")})`,
    );
  }
  return t;
}

function renderDefault(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite default");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${value.replace(/'/g, "''")}'`;
}

function columnDdl(col: ColumnDef): string {
  assertIdentifier(col.name, "column name");
  let s = `${col.name} ${normalizeType(col.type)}`;
  if (col.primaryKey) s += " PRIMARY KEY";
  if (col.notNull) s += " NOT NULL";
  if (col.unique) s += " UNIQUE";
  if (col.default !== undefined) s += ` DEFAULT ${renderDefault(col.default)}`;
  return s;
}

/** Build the DDL string for a changeSpec, namespaced to the project slug. */
export function buildMigrationSql(slug: string, spec: ChangeSpec): string {
  switch (spec.op) {
    case "create_table": {
      if (spec.columns.length === 0) {
        throw new Error("create_table requires at least one column");
      }
      const phys = projectTable(slug, spec.table);
      const cols = spec.columns.map(columnDdl).join(", ");
      return `CREATE TABLE ${phys} (${cols})`;
    }
    case "add_column": {
      const phys = projectTable(slug, spec.table);
      return `ALTER TABLE ${phys} ADD COLUMN ${columnDdl(spec.column)}`;
    }
    case "drop_column": {
      const phys = projectTable(slug, spec.table);
      assertIdentifier(spec.column, "column name");
      return `ALTER TABLE ${phys} DROP COLUMN ${spec.column}`;
    }
    case "rename_column": {
      const phys = projectTable(slug, spec.table);
      assertIdentifier(spec.from, "column name");
      assertIdentifier(spec.to, "column name");
      return `ALTER TABLE ${phys} RENAME COLUMN ${spec.from} TO ${spec.to}`;
    }
    case "rename_table": {
      const from = projectTable(slug, spec.from);
      const to = projectTable(slug, spec.to);
      return `ALTER TABLE ${from} RENAME TO ${to}`;
    }
    case "create_index": {
      const phys = projectTable(slug, spec.table);
      if (spec.columns.length === 0) {
        throw new Error("create_index requires at least one column");
      }
      for (const c of spec.columns) assertIdentifier(c, "column name");
      const idx = spec.name
        ? projectTable(slug, spec.name)
        : `${phys}_${spec.columns.join("_")}_idx`;
      assertIdentifier(idx, "index name");
      const unique = spec.unique ? "UNIQUE " : "";
      return `CREATE ${unique}INDEX ${idx} ON ${phys} (${spec.columns.join(", ")})`;
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  project_slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  op TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  sql TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  UNIQUE (project_slug, version)
);
`;

interface MigrationRow {
  id: number;
  project_slug: string;
  version: number;
  op: string;
  spec_json: string;
  sql: string;
  applied_at: number;
}

function toRecord(row: MigrationRow): MigrationRecord {
  return {
    id: row.id,
    projectSlug: row.project_slug,
    version: row.version,
    op: row.op,
    spec: JSON.parse(row.spec_json) as ChangeSpec,
    sql: row.sql,
    appliedAt: row.applied_at,
  };
}

export class Migrator {
  constructor(
    private readonly db: Db,
    private readonly manifest: ProjectManifest,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  /** Apply a schema change to a project: validate, run DDL, record, touch. */
  migrate(slug: string, spec: ChangeSpec): MigrationRecord {
    if (!this.manifest.get(slug)) {
      throw new Error(`unknown project: ${slug}`);
    }
    const sql = buildMigrationSql(slug, spec);
    const ts = this.now();

    const run = this.db.transaction(() => {
      this.db.exec(sql);
      const version =
        (
          this.db
            .prepare(
              `SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations WHERE project_slug = ?`,
            )
            .get(slug) as { v: number }
        ).v + 1;
      const info = this.db
        .prepare(
          `INSERT INTO schema_migrations (project_slug, version, op, spec_json, sql, applied_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(slug, version, spec.op, JSON.stringify(spec), sql, ts);
      this.manifest.touchProject(slug);
      return Number(info.lastInsertRowid);
    });

    const id = run();
    const row = this.db
      .prepare(`SELECT * FROM schema_migrations WHERE id = ?`)
      .get(id) as MigrationRow;
    return toRecord(row);
  }

  history(slug: string): MigrationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM schema_migrations WHERE project_slug = ? ORDER BY version`,
      )
      .all(slug) as MigrationRow[];
    return rows.map(toRecord);
  }
}
