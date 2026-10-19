import { MAINTENANCE } from "../kernel/caretaker.js";
import { isSqlWrite } from "../risk/rules.js";

/**
 * Which tables the sql tool may touch.
 *
 * The workspace database holds two kinds of table. A project's are
 * namespaced to its slug and are the agent's to read and write. The rest
 * are KOS's own: conversations and transcripts, the approval queue, the
 * permission rules, memory, the audit log. An agent reached those once,
 * through sqlite_master, to queue a message by hand; the same road leads
 * to marking its own ask approved. So the sql tool refuses them, reads
 * included, and sends the agent to the tool that does the job.
 *
 * Maintenance is the exception: it is where KOS repairs itself, and a
 * repair may need to look at a job's rows or a queue. There, reads are
 * allowed and writes ask as any write does, but the trust tables are
 * never written by a model from anywhere.
 *
 * The list is KOS's own, by name, and a test boots a fresh kernel to
 * check nothing has been added without being named here.
 */

export const KERNEL_TABLES = new Set([
  "audit_log",
  "browser_frames",
  "button_routes",
  "chat_sessions",
  "chat_session_earlier",
  "conversation_active",
  "conversations",
  "crons",
  "daemons",
  "health_state",
  "improvements",
  "instance_config",
  "kill_switch",
  "manifest",
  "page_watches",
  "pages",
  "pending_actions",
  "pending_messages",
  "permission_rules",
  "runs_log",
  "schema_migrations",
  "settings",
  "token_usage",
]);

/** Families of KOS's own tables: the memory stores and their index shadows, and SQLite's. */
export const KERNEL_TABLE_PREFIXES = ["memory_", "sqlite_"];

/** Written by nobody but the owner, through the dashboard. */
export const TRUST_TABLES = new Set(["pending_actions", "permission_rules", "kill_switch"]);

export function isKernelTable(name: string): boolean {
  const lower = name.toLowerCase();
  return KERNEL_TABLES.has(lower) || KERNEL_TABLE_PREFIXES.some((p) => lower.startsWith(p));
}

/** The tables a statement reaches, among those that exist: names that appear as words in it. */
export function tablesIn(sql: string, existing: readonly string[]): string[] {
  const lower = sql.toLowerCase();
  return existing.filter((t) => new RegExp(`(^|[^a-z0-9_])${t.toLowerCase()}([^a-z0-9_]|$)`).test(lower));
}

export interface FenceVerdict {
  /** The statement may run. */
  ok: boolean;
  /** Why not, said to the model. */
  reason?: string;
  /** Rows from the schema listing that name a kernel table are dropped before the answer goes back. */
  hideKernelRows: boolean;
}

/** Judge one statement for the calling project. `existing` is every table in the database. */
export function fence(sql: string, existing: readonly string[], project: string | undefined): FenceVerdict {
  const kernel = tablesIn(sql, existing).filter(isKernelTable);
  const trust = kernel.filter((t) => TRUST_TABLES.has(t));
  if (isSqlWrite(sql) && trust.length) {
    return {
      ok: false,
      hideKernelRows: false,
      reason: `${trust.join(", ")}: KOS's trust tables are never written through sql. Approvals and permissions are the owner's, in the dashboard.`,
    };
  }
  if (project === MAINTENANCE.slug) return { ok: true, hideKernelRows: false };
  // The schema listing is how a project finds its own tables; it goes through, minus the rows that are KOS's.
  const own = kernel.filter((t) => !t.startsWith("sqlite_"));
  if (own.length) {
    return {
      ok: false,
      hideKernelRows: false,
      reason:
        `${own.join(", ")}: ${own.length === 1 ? "that table is" : "those tables are"} KOS's own, not a project's. ` +
        "Use the tool for the job (chats.handoff to pass something to another chat, memory for facts, cron for jobs); sql is for your project's tables.",
    };
  }
  return { ok: true, hideKernelRows: kernel.length > 0 };
}

/** A row from the schema listing that names a kernel table, to be dropped. */
export function namesKernelTable(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  const name = typeof r["name"] === "string" ? r["name"] : typeof r["tbl_name"] === "string" ? r["tbl_name"] : undefined;
  return name !== undefined && isKernelTable(name);
}
