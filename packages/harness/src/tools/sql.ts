import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { isSqlDestructive } from "../risk/rules.js";
import type { Db } from "../store/db.js";
import { fence, isKernelTable, MAINTENANCE_SLUG, ownedBy, ownerOf, tableNames, type Reach } from "./fence.js";

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

/** Said after a missing-table error outside Maintenance: the next step is a handoff, not a search. */
const HAND_TO_MAINTENANCE = "If this is not yours to fix, hand it to Maintenance (chats.handoff to @project:maintenance) with what you saw.";

/**
 * "no such table: budget_tracker.expenses" is true and useless: it does not say
 * what the table is called, and a model that guessed the dotted or logical name
 * guesses again the same way. Answered with the tables the caller may reach,
 * and with the namespaced one when that is plainly what was meant. It used to
 * list every table in the workspace, which was a map for looking around.
 */
function explainMissingTable(db: Db, message: string, reach: Reach): string {
  const named = /no such table:\s*([^\s]+)/.exec(message)?.[1];
  if (!named) return message;
  const all = tableNames(db);
  const maintenance = reach.project === MAINTENANCE_SLUG;
  const siblings = reach.projects.map((p) => p.slug);
  const tables = maintenance ? all : reach.project ? all.filter((t) => !isKernelTable(t) && ownedBy(t, reach.project!, siblings)) : [];
  // A dotted or logical name usually differs from the physical one only in the
  // separator, so the physical table is findable by normalising both.
  const key = named.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const match = tables.find((t) => t.replace(/[^a-z0-9]/gi, "").toLowerCase() === key);
  if (match) return `${message}. Did you mean "${match}"?`;
  const suffix = tables.find((t) => t.toLowerCase().endsWith(`_${named.toLowerCase()}`));
  if (suffix) return `${message}. Tables are namespaced to their project: use "${suffix}".`;
  if (!maintenance) {
    // Named a table that exists but is another project's: say whose, not where.
    const elsewhere = all.find((t) => !isKernelTable(t) && (t.replace(/[^a-z0-9]/gi, "").toLowerCase() === key || t.toLowerCase().endsWith(`_${named.toLowerCase()}`)));
    const owner = elsewhere ? ownerOf(elsewhere, reach.projects) : undefined;
    if (owner) return `${message}. That is the ${owner.name} project's table, not this chat's: hand the question there (chats.handoff to @project:${owner.slug}). ${HAND_TO_MAINTENANCE}`;
    if (!reach.project) return `${message}. This chat belongs to no project, so no table is its to read: ask KOS at the root, which routes a question to the project that owns the data. ${HAND_TO_MAINTENANCE}`;
    return tables.length
      ? `${message}. This project's tables: ${tables.join(", ")}. ${HAND_TO_MAINTENANCE}`
      : `${message}. This project has no tables yet; create one with systems.migrate. ${HAND_TO_MAINTENANCE}`;
  }
  return tables.length ? `${message}. Tables in this workspace: ${tables.join(", ")}` : `${message}. This workspace has no tables yet; create one with systems.migrate.`;
}

function runSql(db: Db, input: Record<string, unknown>, reach: Reach): string {
  const sql = sqlOf(input);
  assertDml(sql);
  const verdict = fence(sql, tableNames(db), reach);
  if (!verdict.ok) throw new Error(verdict.reason);
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(/no such table/i.test(message) ? explainMissingTable(db, message, reach) : message);
  }
  if (stmt.reader) return JSON.stringify(stmt.all(...paramsOf(input)));
  const info = stmt.run(...paramsOf(input));
  return JSON.stringify({ changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) });
}

/** Who is asking, read at call time: the caller's project and every project's name, so a refusal can say whose a table is. */
export function reachOf(ctx: ModuleContext): Reach {
  return {
    project: ctx.services?.callerProject?.(),
    projects: (ctx.services?.manifest?.list() ?? []).map((p) => ({ slug: p.slug, name: p.name })),
  };
}

export function defineSqlTool(db: Db, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "sql",
      description:
        "Run one DML statement (SELECT/INSERT/UPDATE/DELETE) against your own project's tables, the ones listed in your prompt with their columns. Use ? placeholders and the params array. DDL is not allowed; use migrate. " +
        "Nothing else is reachable here: another project's tables are that project's to answer for (chats.handoff to @project:<slug>), the schema is Maintenance's to read, and KOS's own tables (conversations, jobs, pending messages and actions, permissions, memory) are read through cron.list, chats.list and chats.read, tasks.list, blobs.list and memory.recall. " +
        "A chat with no project has no tables. When something looks wrong, hand it to Maintenance rather than investigating.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" },
          params: { type: "array" },
        },
        required: ["sql"],
      },
    },
    (input) => runSql(db, input, reachOf(ctx)),
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
