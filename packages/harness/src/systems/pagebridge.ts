import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { isReadOnlyQuery, type HtmlPage, type MutationTarget } from "@kos/shared";

import type { Db } from "../store/db.js";
import type { Workspace } from "../store/workspace.js";
import { executeMutation, type MutationResult, type WidgetEdit } from "../widgets/mutation.js";
import { runDisplayQuery, type DisplayQueryOptions, type DisplayQueryResult } from "./display.js";
import { ownerOf } from "./pages.js";

/**
 * What an HTML page may do through `window.kos`, decided here, on the server.
 *
 * The page's frame is sandboxed and has no network, so these calls are its
 * only way to KOS. Every one is checked against what the page declared when
 * it was written, and against its project. The dashboard relays them, but
 * relaying is all it does: a page that lies in its script, or a dashboard
 * tab someone has tampered with, still reaches only this.
 */

/** A call a page made that its declarations do not allow. */
export class BridgeRefusal extends Error {}

/** A page, with the project it belongs to and every project's slug, to say whose a table is. */
export interface BridgePage {
  page: HtmlPage;
  projectSlug: string;
  slugs: string[];
}

/** Most parameters a query may bind, and the longest text file a page may read. */
const MAX_PARAMS = 50;
const FILE_MAX = 256_000;

type Param = string | number | null;

function paramsOf(raw: unknown): Param[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PARAMS) throw new BridgeRefusal(`params must be a list of at most ${MAX_PARAMS} values`);
  return raw.map((v) => {
    if (v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    throw new BridgeRefusal("a param must be text, a number, true/false or null");
  });
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
  const plan = db.prepare(`EXPLAIN ${sql}`).all(...params) as { opcode: string; p2: number; p3: number }[];
  const roots = new Map(
    (db.prepare(`SELECT tbl_name, rootpage FROM sqlite_master WHERE rootpage > 0`).all() as { tbl_name: string; rootpage: number }[]).map((r) => [r.rootpage, r.tbl_name]),
  );
  const tables = new Set<string>();
  for (const step of plan) {
    if (step.opcode === "VOpen") throw new BridgeRefusal("a page cannot read a virtual table or a pragma");
    if (step.opcode !== "OpenRead" && step.opcode !== "ReopenIdx") continue;
    if (step.p3 !== 0) throw new BridgeRefusal("a page reads only the workspace's own database");
    if (step.p2 === 1) throw new BridgeRefusal("a page cannot read the schema");
    const name = roots.get(step.p2);
    if (!name) throw new BridgeRefusal("the query reads something that is not a table of this workspace");
    tables.add(name);
  }
  return [...tables];
}

/** A read-only query over the page's own project's tables, capped in rows and time. */
export function pageQuery(reader: Db, bridge: BridgePage, sql: unknown, rawParams: unknown, options: DisplayQueryOptions = {}): DisplayQueryResult {
  if (bridge.page.capabilities?.query === false) throw new BridgeRefusal("this page does not declare queries");
  if (typeof sql !== "string" || !sql.trim()) throw new BridgeRefusal("sql is required");
  if (!isReadOnlyQuery(sql)) throw new BridgeRefusal("a page query must be a single read-only SELECT or WITH");
  const params = paramsOf(rawParams);
  for (const table of tablesRead(reader, sql, params)) {
    const owner = ownerOf(table, bridge.slugs);
    if (owner !== bridge.projectSlug) {
      throw new BridgeRefusal(`"${table}" is ${owner ? `project "${owner}"'s` : "not a project's"} table; this page reads only "${bridge.projectSlug}"'s`);
    }
  }
  return runDisplayQuery(reader, sql, { ...options, params });
}

/** The target a page declared for a table, or a refusal naming what it may write. */
function targetFor(bridge: BridgePage, table: unknown): MutationTarget {
  const declared = bridge.page.capabilities?.writes ?? [];
  const target = declared.find((t) => t.table === table);
  if (!target) {
    throw new BridgeRefusal(
      declared.length
        ? `this page may write only ${declared.map((t) => `"${t.table}"`).join(", ")}, not "${String(table)}"`
        : "this page does not declare any writes",
    );
  }
  if (ownerOf(target.table, bridge.slugs) !== bridge.projectSlug) throw new BridgeRefusal(`"${target.table}" is not this page's project's table`);
  return target;
}

/** One change to a declared table, through the same guarded path the widgets use. */
export function pageWrite(db: Db, bridge: BridgePage, req: { table?: unknown; op?: unknown; values?: unknown; key?: unknown }): MutationResult {
  const target = targetFor(bridge, req.table);
  const values = (typeof req.values === "object" && req.values !== null ? req.values : {}) as Record<string, unknown>;
  const key = req.key as { column?: unknown; value?: unknown } | undefined;
  const keyed = (): { column: string; value: unknown } => {
    if (!key || typeof key.column !== "string") throw new BridgeRefusal(`${String(req.op)} needs a key: { column, value }`);
    return { column: key.column, value: key.value };
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
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) throw new BridgeRefusal("a page reads files only inside its own project");
  if (rel.split(sep)[0] === ".history") throw new BridgeRefusal("a page cannot read its own history");
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new BridgeRefusal(`no file at ${path}`);
  const text = readFileSync(abs, "utf8");
  return { path: rel.split(sep).join("/"), text: text.slice(0, FILE_MAX), truncated: text.length > FILE_MAX };
}
