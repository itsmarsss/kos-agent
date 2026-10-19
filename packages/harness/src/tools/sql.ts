import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { isSqlDestructive } from "../risk/rules.js";
import type { Db } from "../store/db.js";
import { fence, isKernelTable, namesKernelTable } from "./fence.js";

/**
 * The `sql` tool module: run DML against the workspace SQLite. SELECT and
 * INSERT are safe: a read, and a row added to a table of the owner's own.
 * UPDATE and DELETE change or remove what is there, so they escalate to
 * risky and go to the approval queue. DDL is rejected here on purpose:
 * schema changes must go through the guarded `migrate` primitive so the
 * manifest and migration history stay under harness control.
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

/**
 * "no such table: budget_tracker.expenses" is true and useless: it does not say
 * what the table is called, and a model that guessed the dotted or logical name
 * guesses again the same way. Answered with the tables that do exist, and with
 * the namespaced one when that is plainly what was meant.
 */
function explainMissingTable(db: Db, message: string, showKernel: boolean): string {
  const named = /no such table:\s*([^\s]+)/.exec(message)?.[1];
  if (!named) return message;
  const tables = tableNames(db).filter((t) => showKernel || !isKernelTable(t));
  // A dotted or logical name usually differs from the physical one only in the
  // separator, so the physical table is findable by normalising both.
  const key = named.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const match = tables.find(
    (t) => t.replace(/[^a-z0-9]/gi, "").toLowerCase() === key,
  );
  if (match) return `${message}. Did you mean "${match}"?`;
  const suffix = tables.find((t) => t.toLowerCase().endsWith(`_${named.toLowerCase()}`));
  if (suffix) {
    return `${message}. Tables are namespaced to their project: use "${suffix}".`;
  }
  return tables.length
    ? `${message}. Tables in this workspace: ${tables.join(", ")}`
    : `${message}. This workspace has no tables yet; create one with systems.migrate.`;
}

/** Every table in the database, SQLite's own included. */
function tableNames(db: Db): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name).concat("sqlite_master");
}

function runSql(db: Db, input: Record<string, unknown>, project: string | undefined): string {
  const sql = sqlOf(input);
  assertDml(sql);
  const verdict = fence(sql, tableNames(db), project);
  if (!verdict.ok) throw new Error(verdict.reason);
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      /no such table/i.test(message) ? explainMissingTable(db, message, project === "maintenance") : message,
    );
  }
  if (stmt.reader) {
    const rows = stmt.all(...paramsOf(input));
    // A project listing the schema sees its own tables and not KOS's.
    return JSON.stringify(verdict.hideKernelRows ? rows.filter((r) => !namesKernelTable(r)) : rows);
  }
  const info = stmt.run(...paramsOf(input));
  return JSON.stringify({ changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) });
}

export function defineSqlTool(db: Db, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "sql",
      description:
        "Run one DML statement (SELECT/INSERT/UPDATE/DELETE) against your project's tables in the workspace database. Use ? placeholders and the params array. DDL is not allowed; use migrate. " +
        "KOS's own tables (conversations, pending messages and actions, permissions, memory) are not reachable here: use chats.handoff, memory and cron for those.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" },
          params: { type: "array" },
        },
        required: ["sql"],
      },
    },
    (input) => runSql(db, input, ctx.services?.callerProject?.()),
    {
      floor: "safe",
      escalate: (input) =>
        typeof input.sql === "string" && isSqlDestructive(input.sql) ? "changes or removes rows" : false,
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
