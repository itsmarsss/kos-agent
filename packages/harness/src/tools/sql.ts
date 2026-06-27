import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { isSqlWrite } from "../risk/rules.js";
import type { Db } from "../store/db.js";

/**
 * The `sql` tool module: run DML against the workspace SQLite. SELECT is safe;
 * INSERT/UPDATE/DELETE escalate to risky and go to the approval queue. DDL is
 * rejected here on purpose: schema changes must go through the guarded `migrate`
 * primitive so the manifest and migration history stay under harness control.
 */

const DDL_RE = /\b(create|alter|drop|truncate|attach|detach|vacuum|reindex)\b/i;
const MULTI_STATEMENT = /;\s*\S/;

function sqlOf(input: Record<string, unknown>): string {
  const v = input.sql;
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error("sql tool requires a non-empty sql string");
  }
  return v;
}

function paramsOf(input: Record<string, unknown>): unknown[] {
  const p = input.params;
  return Array.isArray(p) ? p : [];
}

/** Reject DDL and stacked statements; those are not the sql tool's job. */
function assertDml(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (MULTI_STATEMENT.test(trimmed)) {
    throw new Error("multiple statements are not allowed; run one at a time");
  }
  if (DDL_RE.test(trimmed)) {
    throw new Error("DDL is not allowed via sql; use the migrate primitive");
  }
}

function runSql(db: Db, input: Record<string, unknown>): string {
  const sql = sqlOf(input);
  assertDml(sql);
  const stmt = db.prepare(sql);
  if (stmt.reader) {
    const rows = stmt.all(...paramsOf(input));
    return JSON.stringify(rows);
  }
  const info = stmt.run(...paramsOf(input));
  return JSON.stringify({ changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) });
}

export function defineSqlTool(db: Db, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "sql",
      description:
        "Run one DML statement (SELECT/INSERT/UPDATE/DELETE) against the workspace database. Use ? placeholders and the params array. DDL is not allowed; use migrate.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" },
          params: { type: "array" },
        },
        required: ["sql"],
      },
    },
    (input) => runSql(db, input),
    {
      floor: "safe",
      escalate: (input) =>
        typeof input.sql === "string" && isSqlWrite(input.sql),
    },
  );
}

export const sqlModule: KosModule = {
  manifest: {
    name: "sql",
    version: "1.0.0",
    provides: [{ kind: "tool", name: "sql", version: "1.0.0" }],
    riskTier: "safe",
  },
  activate(ctx) {
    const { db } = requireServices(ctx);
    defineSqlTool(db, ctx);
  },
};
