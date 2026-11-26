import type { Db } from "../store/db.js";
import { deletesData } from "../risk/learned.js";
import type { AuditEntry } from "./audit.js";
import { scopeOf, type PermissionStore } from "./permissions.js";

/**
 * What the jobs that ran before consent was kept are taken to have.
 *
 * A job's consent is learned from the owner's yes to its run's asks. Jobs
 * that already ran had their asks approved before that was kept, so each
 * keeps, as its consent, every ask of its runs the owner approved: the
 * same rule the ask named, for that job alone. Not a guest's, not one that
 * reached past its folder, not a delete, not one raised before the job now
 * holding its id was made. Done once: a rule the owner then revokes stays
 * revoked.
 */
export const JOB_CONSENT_KEY = "permissions.jobConsentFromHistory";

interface ApprovedAsk {
  tool: string;
  args: string;
  rule: string;
  job: number;
}

/** The asks of scheduled runs the owner approved, for jobs that still exist and were made before each ask. */
function approvedJobAsks(db: Db): ApprovedAsk[] {
  return db
    .prepare(
      `SELECT p.tool, p.args, p.rule, c.id AS job
       FROM pending_actions p JOIN crons c ON p.conversation_id = 'cron:' || c.id
       WHERE p.status = 'approved' AND p.rule IS NOT NULL AND p.reached = 0 AND p.guest IS NULL AND p.requested_at >= c.created_at
       ORDER BY p.id`,
    )
    .all() as ApprovedAsk[];
}

export function grandfatherJobConsent(
  db: Db,
  permissions: Pick<PermissionStore, "add">,
  settings: { get: <T>(key: string) => T | undefined; set: (key: string, value: unknown) => void },
  audit: { record: (entry: AuditEntry) => unknown },
): number {
  if (settings.get<boolean>(JOB_CONSENT_KEY) === true) return 0;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pending_actions', 'crons')`).all() as { name: string }[];
  const kept = new Set<string>();
  if (tables.length === 2) {
    for (const ask of approvedJobAsks(db)) {
      const args = JSON.parse(ask.args) as Record<string, unknown>;
      if (deletesData(ask.tool, args)) continue;
      const rule = JSON.parse(ask.rule) as { tool: string; scope: string | null; project: string | null };
      // A rule kept as the whole tool before the tool was named by shape (a skill by its name) is kept by that shape now.
      const scope = rule.scope ?? scopeOf(ask.tool, args);
      const key = JSON.stringify([ask.job, rule.tool, scope, rule.project]);
      if (scope === undefined || kept.has(key)) continue;
      kept.add(key);
      const made = permissions.add({ tool: rule.tool, scope, project: rule.project, job: ask.job });
      audit.record({ tool: "permissions.grandfather", args: { job: ask.job, tool: rule.tool, scope }, result: `kept as the job's consent (rule ${made.id})`, isError: false });
    }
  }
  settings.set(JOB_CONSENT_KEY, true);
  return kept.size;
}
