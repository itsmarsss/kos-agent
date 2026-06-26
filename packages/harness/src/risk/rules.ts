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

function hostOf(url: string): string | undefined {
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
