import type { Db } from "../store/db.js";
import { hostOf, isSqlWrite, writtenTables } from "../risk/rules.js";

/**
 * Decisions the owner has made before, kept.
 *
 * Measured on a real workspace: 96 of 97 approvals granted, files.rm alone
 * asked 25 times. A gate the owner always opens is friction, not safety. So
 * a decision can be remembered: approve once and say so, and the same shape
 * stops asking. Shape, not tool: `files.rm` under one directory, `sql` writes
 * to one table, `http.fetch` to one host. A new shape still asks.
 *
 * A rule is bound to the project it was made in, or to everywhere when it
 * was made at the root. The model never writes one; only a decision does.
 * Every rule is listed in Settings and can be revoked there.
 */

export interface PermissionRule {
  id: number;
  tool: string;
  /** `dir:<prefix>`, `host:<name>`, `table:<name>`, or null for tool-wide. */
  scope: string | null;
  /** The project slug it applies in, or null for everywhere. */
  project: string | null;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS permission_rules (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  scope TEXT,
  project TEXT,
  created_at INTEGER NOT NULL
);
`;

function parentDir(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i === -1 ? "" : norm.slice(0, i);
}

/**
 * What a call's scope is, in the terms a rule is written in.
 *
 * Null means the tool is the whole scope: approving it once approves it
 * everywhere it is called the same way. Undefined means the call has a scope
 * this cannot name (a sql write whose table it cannot read), so no rule can
 * match it and it always asks.
 */
export function scopeOf(tool: string, input: Record<string, unknown>): string | null | undefined {
  if (tool.startsWith("files.")) {
    const path = typeof input["path"] === "string" ? input["path"] : typeof input["from"] === "string" ? input["from"] : "";
    return `dir:${parentDir(path)}`;
  }
  if (tool === "http.fetch") {
    const host = typeof input["url"] === "string" ? hostOf(input["url"]) : undefined;
    return host ? `host:${host}` : undefined;
  }
  if (tool === "sql") {
    const sql = typeof input["sql"] === "string" ? input["sql"] : "";
    if (!isSqlWrite(sql)) return null;
    const [table] = writtenTables(sql);
    return table ? `table:${table}` : undefined;
  }
  if (tool === "systems.migrate") {
    const spec = input["spec"];
    const table = typeof spec === "object" && spec !== null ? (spec as { table?: unknown }).table : undefined;
    return typeof table === "string" ? `table:${table.toLowerCase()}` : undefined;
  }
  return null;
}

/** Does a rule's scope cover a call's? Prefix for directories, exact otherwise. */
export function scopeCovers(rule: string | null, call: string | null): boolean {
  if (rule === null) return true;
  if (call === null) return false;
  if (rule.startsWith("dir:") && call.startsWith("dir:")) {
    const r = rule.slice(4);
    const c = call.slice(4);
    return c === r || (r === "" ? true : c.startsWith(`${r}/`));
  }
  return rule === call;
}

export class PermissionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  list(): PermissionRule[] {
    return (
      this.db.prepare(`SELECT * FROM permission_rules ORDER BY id`).all() as {
        id: number;
        tool: string;
        scope: string | null;
        project: string | null;
        created_at: number;
      }[]
    ).map((r) => ({ id: r.id, tool: r.tool, scope: r.scope, project: r.project, createdAt: r.created_at }));
  }

  /** Remember a decision. The same rule twice is one rule. */
  add(rule: { tool: string; scope: string | null; project: string | null }): PermissionRule {
    const existing = this.list().find(
      (r) => r.tool === rule.tool && r.scope === rule.scope && r.project === rule.project,
    );
    if (existing) return existing;
    const info = this.db
      .prepare(`INSERT INTO permission_rules (tool, scope, project, created_at) VALUES (?, ?, ?, ?)`)
      .run(rule.tool, rule.scope, rule.project, this.now());
    return { id: Number(info.lastInsertRowid), ...rule, createdAt: this.now() };
  }

  revoke(id: number): boolean {
    return this.db.prepare(`DELETE FROM permission_rules WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Has the owner already said yes to this?
   *
   * A rule made in a project applies only there; one made at the root
   * applies everywhere. A call whose scope cannot be named never matches.
   */
  allows(tool: string, input: Record<string, unknown>, project?: string): boolean {
    const scope = scopeOf(tool, input);
    if (scope === undefined) return false;
    return this.list().some(
      (r) => r.tool === tool && (r.project === null || r.project === (project ?? null)) && scopeCovers(r.scope, scope),
    );
  }

  /** The rule a decision would make, for showing before it is kept. */
  ruleFor(tool: string, input: Record<string, unknown>, project: string | null): { tool: string; scope: string | null; project: string | null } | undefined {
    const scope = scopeOf(tool, input);
    if (scope === undefined) return undefined;
    return { tool, scope, project };
  }
}
