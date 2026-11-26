import type { Db } from "../store/db.js";
import { learnable } from "../risk/learned.js";
import type { RiskAssessment } from "../risk/tiers.js";
import { hasSecretRef } from "../secrets/inject.js";
import type { AuditEntry } from "./audit.js";
import { scopeOf, type PermissionStore } from "./permissions.js";

/**
 * What the jobs that ran before consent was kept are taken to have.
 *
 * A job's consent is learned from the owner's yes to its run's asks. Jobs
 * that already ran had their asks approved before that was kept, so each
 * keeps, as its consent, every ask of its runs the owner approved: the
 * same rule the ask named, for that job alone. Only an ask a run raised
 * (the job's own, or an unattended turn in its thread that was not the
 * owner's) and the owner decided; never one no learned yes may cover now
 * (risk/learned.ts: a post where others read, a delete, KOS's own tables),
 * one naming the whole tool, one that reached past its folder, or one
 * raised before the job now holding its id was made. Done once: a rule the
 * owner then revokes stays revoked.
 */
export const JOB_CONSENT_KEY = "permissions.jobConsentFromHistory";

interface ApprovedAsk {
  tool: string;
  args: string;
  rule: string;
  job: number;
  yours: number;
}

/** The asks of scheduled runs the owner approved, for jobs that still exist and were made before each ask. */
function approvedJobAsks(db: Db, ownerId: string): ApprovedAsk[] {
  const columns = db.prepare(`PRAGMA table_info(pending_actions)`).all() as { name: string }[];
  const byJob = columns.some((c) => c.name === "job") ? "p.job = c.id OR (p.job IS NULL AND " : "(";
  return db
    .prepare(
      `SELECT p.tool, p.args, p.rule, p.yours, c.id AS job
       FROM pending_actions p JOIN crons c ON ${byJob}p.conversation_id = 'cron:' || c.id AND p.owner = 0 AND p.attended = 0)
       WHERE p.status = 'approved' AND p.decided_by = ? AND p.rule IS NOT NULL AND p.reached = 0 AND p.guest IS NULL AND p.requested_at >= c.created_at
       ORDER BY p.id`,
    )
    .all(ownerId) as ApprovedAsk[];
}

export function grandfatherJobConsent(
  db: Db,
  permissions: Pick<PermissionStore, "add">,
  settings: { get: <T>(key: string) => T | undefined; set: (key: string, value: unknown) => void },
  audit: { record: (entry: AuditEntry) => unknown },
  /** How the call is judged now, by its tool's own rules. */
  judge: (tool: string, args: Record<string, unknown>) => RiskAssessment,
  ownerId: string,
): number {
  if (settings.get<boolean>(JOB_CONSENT_KEY) === true) return 0;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pending_actions', 'crons')`).all() as { name: string }[];
  const kept = new Set<string>();
  if (tables.length === 2) {
    for (const ask of approvedJobAsks(db, ownerId)) {
      const args = JSON.parse(ask.args) as Record<string, unknown>;
      const call = { tool: ask.tool, input: args, assessment: judge(ask.tool, args), guest: false, secret: hasSecretRef(args), strict: false, yours: ask.yours === 1 };
      if (!learnable(call)) continue;
      const rule = JSON.parse(ask.rule) as { tool: string; scope: string | null; project: string | null };
      // A rule kept as the whole tool before the tool was named by shape (a skill by its name) is kept by that shape now; one that still names the whole tool is not kept.
      const scope = rule.scope ?? scopeOf(ask.tool, args);
      const key = JSON.stringify([ask.job, rule.tool, scope, rule.project]);
      if (scope === undefined || scope === null || kept.has(key)) continue;
      kept.add(key);
      const made = permissions.add({ tool: rule.tool, scope, project: rule.project, job: ask.job });
      audit.record({ tool: "permissions.grandfather", args: { job: ask.job, tool: rule.tool, scope }, result: `kept as the job's consent (rule ${made.id})`, isError: false });
    }
  }
  settings.set(JOB_CONSENT_KEY, true);
  return kept.size;
}
