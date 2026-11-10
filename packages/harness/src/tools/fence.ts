import { MAINTENANCE } from "../kernel/caretaker.js";
import type { GuestOrigin } from "../kernel/caller.js";
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
 * trust tables are never written by a model from anywhere. That reach is
 * for work the owner or KOS started: a guest's words, said in its channel
 * or handed to it, reach no table there.
 *
 * What a statement reaches is what SQLite's plan for it opens, not the
 * words it is spelled with: a book tracker's `pages` column is not KOS's
 * `pages` table, and `'crons'` in quotes is still the crons table.
 *
 * The list of KOS's tables is by name, and a test boots a fresh kernel to
 * check nothing has been added without being named here.
 */

export const KERNEL_TABLES = new Set([
  "audit_log",
  "blob_ids",
  "browser_frames",
  "button_routes",
  "chat_sessions",
  "chat_session_earlier",
  "conversation_active",
  "conversations",
  "crons",
  "daemons",
  "device_settings",
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
export const TRUST_TABLES = new Set(["pending_actions", "permission_rules", "kill_switch", "devices", "device_settings"]);

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

/**
 * A statement with its comments gone and, unless `values` is kept, its
 * string literals blanked: a word in a value or a remark is no name. Quoted
 * identifiers stay as they are.
 */
export function codeOf(sql: string, values: "strip" | "keep" = "strip"): string {
  return sql.replace(/("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\])|('(?:[^']|'')*')|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (all, ident: string | undefined, value: string | undefined) =>
    ident ?? (value !== undefined && values === "keep" ? value : " "),
  );
}

/** A statement that reads the schema itself: SQLite's catalogue, a PRAGMA, its table-valued pragma_* functions, or dbstat. */
export function readsSchema(sql: string): boolean {
  return /\bsqlite_(?:master|schema|temp_master|temp_schema)\b/i.test(sql) || /^\s*pragma\b/i.test(sql) || /\bpragma_\w+/i.test(sql) || /\bdbstat\b/i.test(sql);
}

/** The table-valued functions that read only what they are given: a project's JSON documents, taken apart. */
const JSON_FUNCTIONS = /\bjson_(?:each|tree)\s*\(/gi;

/**
 * What a statement reaches as SQLite would run it: the tables its plan
 * opens, by root page, to read and to write. Words lie both ways: a column
 * or a value named `pages` is not KOS's table, and a name in quotes or
 * behind a comment still is. An index counts as its table, root page 1 is
 * the catalogue, and a table outside the main database (temp, attached)
 * is nobody's project's.
 *
 * A virtual table's cursor does not say which it is, so the plan counts
 * them: the memory index, a pragma_* function, dbstat, json_each. Only the
 * JSON functions read nothing but their arguments, and `virtual` is true
 * when the plan opens more of those cursors than the statement calls them,
 * or when it names any other virtual table or the schema, in quotes or in
 * a value, which SQLite can take for a name.
 */
export interface Plan {
  reads: string[];
  writes: string[];
  /** A virtual table other than the JSON functions, or a write to any. */
  virtual: boolean;
  /** A table of the temp or an attached database. */
  elsewhere: boolean;
}

/** The plan of a statement, or nothing for one that does not compile: no such table, a syntax error, the wrong count of params. */
export function planOf(db: Db, sql: string, params: readonly unknown[] = []): Plan | undefined {
  let ops: { opcode: string; p2: number; p3: number }[];
  try {
    ops = db.prepare(`EXPLAIN ${sql}`).all(...params) as typeof ops;
  } catch {
    return undefined;
  }
  const catalogue = db.prepare("SELECT rootpage, tbl_name, type, sql FROM sqlite_master").all() as { rootpage: number | null; tbl_name: string; type: string; sql: string | null }[];
  const pages = new Map(catalogue.filter((r) => r.rootpage).map((r) => [r.rootpage!, r.tbl_name]));
  const tableAt = (page: number): string => (page === 1 ? "sqlite_master" : (pages.get(page) ?? "sqlite_master"));
  const reads = new Set<string>();
  const writes = new Set<string>();
  let elsewhere = false;
  let cursors = 0;
  let vwrite = false;
  for (const op of ops) {
    if (op.opcode === "VOpen") cursors++;
    else if (op.opcode === "VUpdate") vwrite = true;
    else if (op.opcode === "OpenRead" || op.opcode === "ReopenIdx" || op.opcode === "OpenWrite") {
      if (op.p3 !== 0) elsewhere = true;
      else (op.opcode === "OpenWrite" ? writes : reads).add(tableAt(op.p2));
    }
  }
  let virtual = vwrite;
  if (cursors && !virtual) {
    const named = codeOf(sql, "keep");
    const tables = catalogue.filter((r) => r.type === "table" && /^\s*create\s+virtual\b/i.test(r.sql ?? "")).map((r) => r.tbl_name);
    virtual =
      cursors > (codeOf(sql).match(JSON_FUNCTIONS)?.length ?? 0) ||
      readsSchema(named) ||
      tables.some((t) => new RegExp(`(^|[^a-z0-9_])${t.toLowerCase()}([^a-z0-9_]|$)`).test(named.toLowerCase()));
  }
  return { reads: [...reads], writes: [...writes], virtual, elsewhere };
}

/**
 * Whether a statement writes one of KOS's own tables, by its plan. One that
 * also reaches a virtual table (the memory index) or outside the main
 * database counts, since no project's table is either: asking about a
 * project's write that reads one is the cheaper mistake. A statement that
 * does not compile writes nothing.
 */
export function writesKernelTable(db: Db, sql: string, params: readonly unknown[] = []): boolean {
  const plan = planOf(db, sql, params);
  return plan !== undefined && (plan.virtual || plan.elsewhere || plan.writes.some(isKernelTable));
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
  /** The blob whose own thread this is, by name and id; it reaches no tables, and only its own artifacts. */
  blob?: { name: string; id: string } | undefined;
  /** The owner started this turn in a chat of their own: not a schedule's run, a guest's words, or work passed on. */
  owner?: boolean;
  projects: readonly Owner[];
  /**
   * Projects this turn made, which it may build as their own chats do. A chat
   * with no project could create a project's table and then not fill it, and
   * spent its turn finding a way round: a script, a handoff, a new chat. The
   * reach ends with the turn; a later one hands the work to the project.
   */
  made?: readonly string[];
  /**
   * The room a guest spoke in, when a guest's words started this turn or the
   * work that reached it. Its reach is that room's project, and only in that
   * project's own chats: never Maintenance's, wherever the work was handed.
   */
  guest?: GuestOrigin;
}

/** The projects a chat's statements and schema changes may reach: its own, and those this turn made; for a guest's, its room's alone. */
export function reachable(reach: Reach): string[] {
  if (reach.guest) return reach.project && reach.project === reach.guest.project && reach.project !== MAINTENANCE_SLUG ? [reach.project] : [];
  return [...new Set([...(reach.project ? [reach.project] : []), ...(reach.made ?? [])])];
}

/** Maintenance, on work the owner or KOS started: what reaches KOS's own tables and the schema. */
export function maintains(reach: Reach): boolean {
  return reach.project === MAINTENANCE_SLUG && !reach.guest;
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

/**
 * Judge one statement for the chat asking, by what SQLite's plan for it
 * opens, with `params` bound as the statement will run. One that does not
 * compile is let through for SQLite to say why, but an EXPLAIN of its own
 * has no plan to judge, so only Maintenance runs one.
 */
export function fence(db: Db, sql: string, reach: Reach, params: readonly unknown[] = []): FenceVerdict {
  const plan = planOf(db, sql, params);
  if (!plan) return /^\s*explain\b/i.test(codeOf(sql)) && !maintains(reach) ? refuse("EXPLAIN is Maintenance's: send the statement itself.") : { ok: true };
  const trust = plan.writes.filter((t) => TRUST_TABLES.has(t));
  if (trust.length) {
    return refuse(`${trust.join(", ")}: KOS's trust tables are never written through sql. Approvals and permissions are the owner's, in the dashboard.`);
  }
  if (maintains(reach)) return { ok: true };
  const reached = [...new Set([...plan.reads, ...plan.writes])];
  const schema = plan.virtual || plan.elsewhere || readsSchema(codeOf(sql)) || reached.some((t) => t.toLowerCase().startsWith("sqlite_"));
  const mine = reachable(reach);
  if (reach.guest && !mine.length && (schema || reached.length)) {
    return refuse(
      "a guest's words started this work, so sql reaches only the tables of the project whose channel they spoke in, and this chat is not that project's. " +
        "Answer them with what you know, or tell the owner (notify) what was asked.",
    );
  }
  if (schema) {
    return refuse(
      "the schema is Maintenance's to read, not yours: your project's tables and their columns are listed in your prompt. " +
        "Something that does not match what you expected is Maintenance's to look into: hand it there (chats.handoff to @project:maintenance) with what you saw.",
    );
  }
  const own = reached.filter(isKernelTable);
  if (own.length) {
    return refuse(
      `${own.join(", ")}: ${own.length === 1 ? "that table is" : "those tables are"} KOS's own, not a project's. ` +
        "Use the tool for the job (cron.list for jobs, chats.list and chats.read for chats, tasks.list, blobs.list, memory.recall for facts, chats.handoff to pass something to another chat); sql is for your project's tables.",
    );
  }
  const tables = reached;
  if (!tables.length) return { ok: true };
  const whose = (t: string): string => {
    const owner = ownerOf(t, reach.projects);
    return owner ? `${t} is the ${owner.name} project's` : `${t} belongs to no project`;
  };
  if (!mine.length) {
    // Named outright: a chat that made a project in an earlier turn is
    // looking for that project's own chat, not a lecture on the root.
    const owners = [...new Set(tables.flatMap((t) => ownerOf(t, reach.projects)?.slug ?? []))];
    const next = owners.length
      ? `hand the work to the project that owns it (${owners.map((slug) => `chats.handoff to @project:${slug}`).join(", ")}), or ask KOS at the root`
      : `ask KOS at the root, which routes a question to the project that owns the data, or ${HAND_ON}`;
    return refuse(`${tables.map(whose).join("; ")}. This chat belongs to no project, so no table is its to read or write: ${next}.`);
  }
  const siblings = reach.projects.map((p) => p.slug);
  const others = tables.filter((t) => !mine.some((slug) => ownedBy(t, slug, siblings)));
  if (others.length) {
    const here = mine.map((slug) => reach.projects.find((p) => p.slug === slug)?.name ?? slug).join(" and ");
    return refuse(`${others.map(whose).join("; ")}, not this project's. sql here reaches only the tables of ${here}; ${HAND_ON}.`);
  }
  return { ok: true };
}
