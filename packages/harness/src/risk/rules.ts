import type { Escalation } from "./tiers.js";

/**
 * Reusable argument-escalation rules. Tools attach these so a safe-floor tool
 * (e.g. sql, http.fetch, files) escalates to risky when its arguments cross a
 * line the spec calls out: a write to a sensitive table, a fetch to a
 * non-allowlisted domain, a path outside the scratch area.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SQL_WRITE_RE =
  /\b(insert|update|delete|drop|alter|create|replace|truncate)\b/i;

/** True if the SQL is a write/DDL statement rather than a pure read. */
export function isSqlWrite(sql: string): boolean {
  return SQL_WRITE_RE.test(sql);
}

/** Escalate a sql write that touches any table flagged sensitive. */
export function sqlWriteEscalation(sensitiveTables: string[]): Escalation {
  const patterns = sensitiveTables.map(
    (t) => new RegExp(`\\b${escapeRegex(t)}\\b`, "i"),
  );
  return (input) => {
    const sql = typeof input.sql === "string" ? input.sql : "";
    if (!isSqlWrite(sql)) return false;
    return patterns.some((re) => re.test(sql));
  };
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Escalate an http fetch to a host not on the allowlist (or unparseable). */
export function domainAllowlistEscalation(allowed: string[]): Escalation {
  const set = new Set(allowed.map((d) => d.toLowerCase()));
  return (input) => {
    const url = typeof input.url === "string" ? input.url : "";
    const host = hostOf(url);
    if (host === undefined) return true;
    return !set.has(host);
  };
}

/**
 * Migrate ops that only add to a project's own namespaced schema. They destroy
 * no existing data and no existing identifier, and the timed git snapshots
 * already cover undo, so they run at the safe floor. Every other op (drop,
 * rename) loses data or breaks references that queries and page specs hold, so
 * it stays risky. The migrator namespaces every table to the project slug, so
 * an additive op cannot reach another project's tables.
 */
const ADDITIVE_MIGRATE_OPS = new Set([
  "create_table",
  "add_column",
  "create_index",
]);

/**
 * True only for a changeSpec positively identified as an additive op. Anything
 * malformed, missing, or unrecognized is not additive, so new ops added to
 * ChangeSpec are risky until classified here on purpose.
 */
export function isAdditiveMigration(spec: unknown): boolean {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return false;
  }
  const op = (spec as { op?: unknown }).op;
  return typeof op === "string" && ADDITIVE_MIGRATE_OPS.has(op);
}

/** Escalate a migrate whose spec is not a known additive schema change. */
export const migrationEscalation: Escalation = (input) =>
  !isAdditiveMigration(input.spec);

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Escalate a file path that leaves the scratch prefix or traverses upward. */
export function pathOutsideScratchEscalation(scratchPrefix: string): Escalation {
  const prefix = normalizeSlashes(scratchPrefix);
  return (input) => {
    const path = typeof input.path === "string" ? input.path : "";
    if (path === "") return true;
    if (path.split(/[/\\]/).includes("..")) return true;
    const normalized = normalizeSlashes(path);
    return normalized !== prefix && !normalized.startsWith(`${prefix}/`);
  };
}

/**
 * The tables a write statement touches, lower-cased, in order of appearance.
 *
 * Used to name the scope of a remembered permission: "sql writes to this
 * table" is a thing an owner can mean, "sql writes" is not. Deliberately
 * simple: the statement shapes the agent produces are INSERT INTO t, UPDATE
 * t, DELETE FROM t, and the DDL forms. A statement this cannot read yields
 * no tables, and a rule with no table never matches it.
 */
export function writtenTables(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(?:insert\s+into|update|delete\s+from|alter\s+table|drop\s+table(?:\s+if\s+exists)?|create\s+table(?:\s+if\s+not\s+exists)?|truncate(?:\s+table)?|replace\s+into)\s+[`"\[]?([a-z_][a-z0-9_]*)/gi;
  for (const m of sql.matchAll(re)) {
    const t = m[1]!.toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
