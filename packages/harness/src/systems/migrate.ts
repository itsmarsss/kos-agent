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

/**
 * A default the database computes per row, from a closed vocabulary.
 *
 * A NOT NULL column with no default is a column only the agent can fill: the
 * tasks module's own generated page could not add a row to its own table,
 * because created_at had no way to be set from a form. Expressions are named
 * rather than written so nothing here is a channel for arbitrary SQL.
 */
export interface ComputedDefault {
  expr: keyof typeof EXPRESSIONS;
}

const EXPRESSIONS = {
  /** Epoch milliseconds, matching what the rest of KOS stores. */
  now: "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
  /** ISO-8601, for a column that wants to read as a date in SQL. */
  today: "(date('now'))",
} as const;

export interface ColumnDef {
  name: string;
  type: string;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null | ComputedDefault;
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

function renderDefault(value: NonNullable<ColumnDef["default"]> | null): string {
  if (value === null) return "NULL";
  if (typeof value === "object") {
    const sql = EXPRESSIONS[value.expr];
    if (!sql) throw new Error(`unknown default expression: ${String(value.expr)}`);
    return sql;
  }
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

const OPS = [
  "create_table",
  "add_column",
  "drop_column",
  "rename_column",
  "rename_table",
  "create_index",
] as const;

function keysOf(value: object): string {
  const keys = Object.keys(value);
  return keys.length ? keys.join(", ") : "(none)";
}

function requireString(spec: Record<string, unknown>, field: string, op: string): string {
  const value = spec[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `${op} requires "${field}" as a non-empty string. Got keys: ${keysOf(spec)}`,
    );
  }
  return value;
}

/**
 * A column default is a literal or a named expression, and nothing else.
 * Checked here rather than only at render so a bad spec is rejected where the
 * agent can read why, and so the set of expressions stays closed.
 */
function parseDefault(
  raw: unknown,
  op: string,
  column: string,
): NonNullable<ColumnDef["default"]> | null {
  if (raw === null) return null;
  if (
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  ) {
    return raw;
  }
  const named = raw as { expr?: unknown };
  if (
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof named.expr === "string" &&
    named.expr in EXPRESSIONS
  ) {
    return { expr: named.expr as ComputedDefault["expr"] };
  }
  throw new Error(
    `${op}: column "${column}" default must be a literal or one of ` +
      `${Object.keys(EXPRESSIONS)
        .map((e) => `{"expr":"${e}"}`)
        .join(", ")}`,
  );
}

function parseColumn(raw: unknown, op: string, where: string): ColumnDef {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${op}: ${where} must be an object {name, type}, not ${JSON.stringify(raw)}`,
    );
  }
  const col = raw as Record<string, unknown>;
  if (typeof col["name"] !== "string" || col["name"] === "") {
    throw new Error(`${op}: ${where} needs a "name" string. Got keys: ${keysOf(col)}`);
  }
  if (typeof col["type"] !== "string") {
    throw new Error(
      `${op}: column "${col["name"]}" needs a "type" string, one of ${[...COLUMN_TYPES].join(", ")}`,
    );
  }
  // normalizeType does the allowed-value check and reports the allowed set.
  normalizeType(col["type"]);
  const parsed: ColumnDef = { name: col["name"], type: col["type"] };
  if (col["notNull"] === true) parsed.notNull = true;
  if (col["primaryKey"] === true) parsed.primaryKey = true;
  if (col["unique"] === true) parsed.unique = true;
  if (col["default"] !== undefined) {
    parsed.default = parseDefault(col["default"], op, col["name"]);
  }
  return parsed;
}

function parseColumnList(
  spec: Record<string, unknown>,
  op: string,
): unknown[] {
  const columns = spec["columns"];
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(
      `${op} requires "columns": a non-empty array. Got keys: ${keysOf(spec)}`,
    );
  }
  return columns;
}

/**
 * Turn model-supplied JSON into a ChangeSpec, or explain what is wrong.
 *
 * The spec arrives as free-form JSON from a model that cannot see this type,
 * so every field here is a guess until it is checked. Reading an absent field
 * threw a TypeError whose message named no field and offered no alternative,
 * and a model handed "Cannot read properties of undefined" retries the same
 * shape until it gives up. Each message below names the field, says what it
 * should be, and lists the keys that actually arrived.
 */
export function parseChangeSpec(raw: unknown): ChangeSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`spec must be an object with an "op" field, got ${JSON.stringify(raw)}`);
  }
  const spec = raw as Record<string, unknown>;
  const op = spec["op"];
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) {
    throw new Error(
      `spec.op must be one of ${OPS.join(", ")}. Got ${JSON.stringify(op)}`,
    );
  }

  switch (op) {
    case "create_table":
      return {
        op,
        table: requireString(spec, "table", op),
        columns: parseColumnList(spec, op).map((c, i) =>
          parseColumn(c, op, `columns[${i}]`),
        ),
      };
    case "add_column":
      return {
        op,
        table: requireString(spec, "table", op),
        column: parseColumn(spec["column"], op, `"column"`),
      };
    case "drop_column":
      return {
        op,
        table: requireString(spec, "table", op),
        column: requireString(spec, "column", op),
      };
    case "rename_column":
      return {
        op,
        table: requireString(spec, "table", op),
        from: requireString(spec, "from", op),
        to: requireString(spec, "to", op),
      };
    case "rename_table":
      return {
        op,
        from: requireString(spec, "from", op),
        to: requireString(spec, "to", op),
      };
    default: {
      const columns = parseColumnList(spec, op).map((c, i) => {
        if (typeof c !== "string" || c === "") {
          throw new Error(`${op}: columns[${i}] must be a column name string`);
        }
        return c;
      });
      const index: Extract<ChangeSpec, { op: "create_index" }> = {
        op: "create_index",
        table: requireString(spec, "table", op),
        columns,
      };
      if (spec["unique"] === true) index.unique = true;
      if (typeof spec["name"] === "string") index.name = spec["name"];
      return index;
    }
  }
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

    // "table X already exists" leaves the caller guessing what is in it, so it
    // tries again, then goes looking through PRAGMA and grep. The columns it
    // needs to decide between add_column and doing nothing are right here.
    if (spec.op === "create_table") {
      const columns = this.columnsOf(projectTable(slug, spec.table));
      if (columns.length > 0) {
        throw new Error(
          `table ${projectTable(slug, spec.table)} already exists with columns: ${columns.join(", ")}. Use add_column for anything missing.`,
        );
      }
    }

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

  /** Column names of a physical table, empty when it does not exist. */
  private columnsOf(table: string): string[] {
    return (
      this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name);
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
