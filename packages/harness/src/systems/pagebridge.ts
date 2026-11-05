import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { isReadOnlyQuery, type HtmlPage, type MutationTarget } from "@kos/shared";

import type { Db } from "../store/db.js";
import type { Workspace } from "../store/workspace.js";
import { executeMutation, type MutationResult, type WidgetEdit } from "../widgets/mutation.js";
import type { DisplayQueryResult } from "./display.js";
import { QueryTimeout, type PageQueries, type PageQueryOptions } from "./pagequeries.js";

/**
 * What an HTML page may do through `window.kos`, decided here, on the server.
 *
 * The page's frame is sandboxed and has no network, so these calls are its
 * only way to KOS. Every one is checked against what the page declared when
 * it was written, and against its project. The dashboard relays them, but
 * relaying is all it does: a page that lies in its script, or a dashboard
 * tab someone has tampered with, still reaches only this.
 */

/**
 * A call a page made that its declarations do not allow.
 *
 * The words are the same whatever was refused and why: a refusal that named
 * the project a table belongs to, or passed SQLite's own "no such table"
 * through, let a page map what else the workspace holds.
 */
export class BridgeRefusal extends Error {}

/** A page, its project, and the tables that project made (registered.ts), which are all it may reach. */
export interface BridgePage {
  page: HtmlPage;
  projectSlug: string;
  tables: Set<string>;
}

const NOT_YOURS = "this page reads and writes only its own project's tables";
/**
 * Any query that will not run here. One sentence for a table that is missing,
 * another project's, or KOS's own, and for SQLite's own errors (whose "no such
 * column" would say a table exists), so none tells a page what else is there.
 */
const CANNOT_QUERY = "the query cannot run here: check its SQL, and that it reads only this project's tables";

/** Most parameters a query may bind, and the longest text file a page may read. */
const MAX_PARAMS = 50;
const FILE_MAX = 256_000;

type Param = string | number | null;

/** A value as SQLite takes it: text, a number, null, or true/false as 1/0. */
function valueOf(v: unknown, what: string): Param {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new BridgeRefusal(`${what} must be text, a number, true/false or null`);
}

function paramsOf(raw: unknown): Param[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PARAMS) throw new BridgeRefusal(`params must be a list of at most ${MAX_PARAMS} values`);
  return raw.map((v) => valueOf(v, "a param"));
}

/**
 * The tables a query reads, as SQLite plans it.
 *
 * Asked of the query plan, not guessed from the text: a view, a subquery, a CTE
 * or a quoted name all resolve to the tables SQLite actually opens. A query
 * that reaches the schema itself, another attached database, or a virtual
 * table (which is how pragma functions and full-text indexes are read) is
 * refused outright.
 */
export function tablesRead(db: Db, sql: string, params: Param[]): string[] {
  let plan: { opcode: string; p2: number; p3: number }[];
  try {
    plan = db.prepare(`EXPLAIN ${sql}`).all(...params) as typeof plan;
  } catch {
    throw new BridgeRefusal(CANNOT_QUERY);
  }
  const roots = new Map(
    (db.prepare(`SELECT tbl_name, rootpage FROM sqlite_master WHERE rootpage > 0`).all() as { tbl_name: string; rootpage: number }[]).map((r) => [r.rootpage, r.tbl_name]),
  );
  const tables = new Set<string>();
  for (const step of plan) {
    if (step.opcode === "VOpen") throw new BridgeRefusal(CANNOT_QUERY);
    if (step.opcode !== "OpenRead" && step.opcode !== "ReopenIdx") continue;
    if (step.p3 !== 0 || step.p2 === 1) throw new BridgeRefusal(CANNOT_QUERY);
    const name = roots.get(step.p2);
    if (!name) throw new BridgeRefusal(CANNOT_QUERY);
    tables.add(name);
  }
  return [...tables];
}

/**
 * A read-only query over the page's own project's tables, capped in rows and
 * run apart from the server (pagequeries.ts), so one that never ends is killed
 * rather than holding every other request.
 */
export async function pageQuery(reader: Db, queries: PageQueries, bridge: BridgePage, sql: unknown, rawParams: unknown, options: PageQueryOptions = {}): Promise<DisplayQueryResult> {
  if (bridge.page.capabilities?.query === false) throw new BridgeRefusal("this page does not declare queries");
  if (typeof sql !== "string" || !sql.trim()) throw new BridgeRefusal("sql is required");
  if (!isReadOnlyQuery(sql)) throw new BridgeRefusal("a page query must be a single read-only SELECT or WITH");
  const params = paramsOf(rawParams);
  for (const table of tablesRead(reader, sql, params)) {
    if (!bridge.tables.has(table)) throw new BridgeRefusal(CANNOT_QUERY);
  }
  try {
    return await queries.run(sql, params, options);
  } catch (err) {
    if (err instanceof QueryTimeout) throw new BridgeRefusal(err.message);
    // The query reads only the page's own tables, so what went wrong is the page's to know.
    throw new BridgeRefusal(err instanceof Error ? err.message : String(err));
  }
}

/** The target a page declared for a table, or a refusal naming what it may write. */
function targetFor(bridge: BridgePage, table: unknown): MutationTarget {
  const declared = bridge.page.capabilities?.writes ?? [];
  const target = declared.find((t) => t.table === table);
  if (!target) {
    throw new BridgeRefusal(declared.length ? `this page may write only ${declared.map((t) => `"${t.table}"`).join(", ")}` : "this page does not declare any writes");
  }
  // Declared is not enough: the table must be one its project made.
  if (!bridge.tables.has(target.table)) throw new BridgeRefusal(NOT_YOURS);
  return target;
}

/** The values of a write, each as SQLite takes it. */
function valuesOf(raw: unknown): Record<string, Param> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new BridgeRefusal("values must be an object of column: value");
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, valueOf(v, `values.${k}`)]));
}

/** One change to a declared table, through the same guarded path the widgets use. */
export function pageWrite(db: Db, bridge: BridgePage, req: { table?: unknown; op?: unknown; values?: unknown; key?: unknown }): MutationResult {
  const target = targetFor(bridge, req.table);
  const values = valuesOf(req.values);
  const key = req.key as { column?: unknown; value?: unknown } | undefined;
  const keyed = (): { column: string; value: Param } => {
    if (!key || typeof key !== "object" || typeof key.column !== "string") throw new BridgeRefusal(`${String(req.op)} needs a key: { column, value }`);
    return { column: key.column, value: valueOf(key.value, "key.value") };
  };
  let edit: WidgetEdit;
  if (req.op === "insert") edit = { op: "insert", values };
  else if (req.op === "update") edit = { op: "update", key: keyed(), values };
  else if (req.op === "delete") edit = { op: "delete", key: keyed() };
  else throw new BridgeRefusal("op is insert, update or delete");
  try {
    return executeMutation(db, target, edit);
  } catch (err) {
    throw new BridgeRefusal(err instanceof Error ? err.message : String(err));
  }
}

/** A text file inside the page's own project folder, up to a size. */
export function pageFile(workspace: Workspace, bridge: BridgePage, path: unknown): { path: string; text: string; truncated: boolean } {
  if (!bridge.page.capabilities?.files) throw new BridgeRefusal("this page does not declare file reads");
  if (typeof path !== "string" || !path.trim()) throw new BridgeRefusal("path is required");
  const base = workspace.resolve(join("projects", bridge.projectSlug));
  // Through the jail first, then held to the project's own folder.
  const abs = workspace.resolve(join("projects", bridge.projectSlug, path));
  const rel = relative(base, abs);
  const parts = rel.split(sep);
  if (rel === "" || parts[0] === ".." || parts.includes("..")) throw new BridgeRefusal("a page reads files only inside its own project");
  // Pages and their history are KOS's record of the pages, not the project's files.
  if (parts[0] === "pages" || parts.includes(".history")) throw new BridgeRefusal("a page cannot read the project's pages or their history");
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new BridgeRefusal(`no file at ${path}`);
  // Only as much as a page may have, read from the start; a large file is not read whole first.
  const size = statSync(abs).size;
  const buffer = Buffer.alloc(Math.min(size, FILE_MAX));
  const fd = openSync(abs, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  return { path: parts.join("/"), text: buffer.toString("utf8"), truncated: size > FILE_MAX };
}
