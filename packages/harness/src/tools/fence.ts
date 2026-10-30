import { MAINTENANCE } from "../kernel/caretaker.js";
import { isSqlWrite } from "../risk/rules.js";
import type { Db } from "../store/db.js";

/**
 * Which tables the sql tool may touch.
 *
 * The workspace database holds two kinds of table. A project's are
 * namespaced to its slug and are that project's to read and write. The
 * rest are KOS's own: conversations and transcripts, the approval queue,
 * the permission rules, memory, the audit log. An agent reached those once,
 * through sqlite_master, to queue a message by hand; the same road leads
 * to marking its own ask approved.
 *
 * So a chat reaches the tables of the project it belongs to and nothing
 * else: not KOS's own, not another project's, and not the schema itself.
 * Every chat used to reach every project's tables and could read the
 * catalogue, and an agent that hit something odd went looking through
 * tables that were none of its concern instead of handing the matter on.
 * A chat with no project reaches no table at all.
 *
 * Maintenance is the exception: it is where KOS repairs itself, and a
 * repair may need to look at a job's rows, a queue, or any project's
 * table. There, reads are free and writes ask as any write does, but the
 * trust tables are never written by a model from anywhere.
 *
 * The list of KOS's tables is by name, and a test boots a fresh kernel to
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
  "devices",
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

/** Written by nobody but the owner, through the dashboard. `devices` is the computers KOS may drive. */
export const TRUST_TABLES = new Set(["pending_actions", "permission_rules", "kill_switch", "devices"]);

/** The one project that reaches everything, by its slug, for the tools that judge reach. */
export const MAINTENANCE_SLUG = MAINTENANCE.slug;

export function isKernelTable(name: string): boolean {
  const lower = name.toLowerCase();
  return KERNEL_TABLES.has(lower) || KERNEL_TABLE_PREFIXES.some((p) => lower.startsWith(p));
}

/** Every table in the database, SQLite's own included: what a statement can reach. */
export function tableNames(db: Db): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name).concat("sqlite_master");
}

/** The tables a statement reaches, among those that exist: names that appear as words in it. */
export function tablesIn(sql: string, existing: readonly string[]): string[] {
  const lower = sql.toLowerCase();
  return existing.filter((t) => new RegExp(`(^|[^a-z0-9_])${t.toLowerCase()}([^a-z0-9_]|$)`).test(lower));
}

/** A statement that reads the schema itself: SQLite's catalogue, or a PRAGMA. */
export function readsSchema(sql: string): boolean {
  return /\bsqlite_(?:master|schema|temp_master|temp_schema)\b/i.test(sql) || /^\s*pragma\b/i.test(sql);
}

/** A project as the fence knows it: what its tables start with, and what to call it. */
export interface Owner {
  slug: string;
  name: string;
}

/**
 * Whether a table is one project's, by the migrator's `<slug>_` prefix,
 * which is the ownership rule rather than a heuristic. A longer sibling
 * slug claims its own (pantry_2_items beside pantry).
 */
export function ownedBy(table: string, slug: string, siblings: readonly string[]): boolean {
  const lower = table.toLowerCase();
  if (lower !== slug && !lower.startsWith(`${slug}_`)) return false;
  return !siblings.some((other) => other !== slug && other.length > slug.length && (lower === other || lower.startsWith(`${other}_`)));
}

/** The project a table belongs to, when one does; the longest slug wins. */
export function ownerOf(table: string, projects: readonly Owner[]): Owner | undefined {
  const lower = table.toLowerCase();
  let found: Owner | undefined;
  for (const p of projects) {
    if ((lower === p.slug || lower.startsWith(`${p.slug}_`)) && (!found || p.slug.length > found.slug.length)) found = p;
  }
  return found;
}

/** Who is asking: the project the chat belongs to, none at the root, and every project so an owner can be named. */
export interface Reach {
  project: string | undefined;
  projects: readonly Owner[];
}

export interface FenceVerdict {
  /** The statement may run. */
  ok: boolean;
  /** Why not, said to the model. */
  reason?: string;
}

const refuse = (reason: string): FenceVerdict => ({ ok: false, reason });

/** Where to send what is not this chat's: the owning project, or Maintenance when something looks wrong. */
export const HAND_ON = "hand the question to the project that owns the data (chats.handoff to @project:<slug>), or to Maintenance (chats.handoff to @project:maintenance) when something looks wrong";

/** Judge one statement for the chat asking. `existing` is every table in the database. */
export function fence(sql: string, existing: readonly string[], reach: Reach): FenceVerdict {
  const reached = tablesIn(sql, existing);
  const kernel = reached.filter(isKernelTable);
  const trust = kernel.filter((t) => TRUST_TABLES.has(t));
  if (isSqlWrite(sql) && trust.length) {
    return refuse(`${trust.join(", ")}: KOS's trust tables are never written through sql. Approvals and permissions are the owner's, in the dashboard.`);
  }
  if (reach.project === MAINTENANCE_SLUG) return { ok: true };
  if (readsSchema(sql)) {
    return refuse(
      "the schema is Maintenance's to read, not yours: your project's tables and their columns are listed in your prompt. " +
        "Something that does not match what you expected is Maintenance's to look into: hand it there (chats.handoff to @project:maintenance) with what you saw.",
    );
  }
  const own = kernel.filter((t) => !t.startsWith("sqlite_"));
  if (own.length) {
    return refuse(
      `${own.join(", ")}: ${own.length === 1 ? "that table is" : "those tables are"} KOS's own, not a project's. ` +
        "Use the tool for the job (cron.list for jobs, chats.list and chats.read for chats, tasks.list, blobs.list, memory.recall for facts, chats.handoff to pass something to another chat); sql is for your project's tables.",
    );
  }
  const tables = reached.filter((t) => !isKernelTable(t));
  if (tables.length === 0) return { ok: true };
  const whose = (t: string): string => {
    const owner = ownerOf(t, reach.projects);
    return owner ? `${t} is the ${owner.name} project's` : `${t} belongs to no project`;
  };
  if (!reach.project) {
    return refuse(`${tables.map(whose).join("; ")}. This chat belongs to no project, so no table is its to read or write: ask KOS at the root, which routes a question to the project that owns the data, or ${HAND_ON}.`);
  }
  const siblings = reach.projects.map((p) => p.slug);
  const others = tables.filter((t) => !ownedBy(t, reach.project!, siblings));
  if (others.length) {
    const here = reach.projects.find((p) => p.slug === reach.project)?.name ?? reach.project;
    return refuse(`${others.map(whose).join("; ")}, not this project's. sql here reaches only the tables of ${here}; ${HAND_ON}.`);
  }
  return { ok: true };
}
