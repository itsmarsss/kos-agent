import { PRIVATE_TOOLS } from "@kos/shared";

import { isSqlDestructive } from "./rules.js";
import type { RiskAssessment } from "./tiers.js";

/**
 * What a learned yes may never cover.
 *
 * Two kinds of yes outlive the ask they answered without the owner
 * pressing Always: a burst (the same step again in the same chat, a moment
 * after the owner approved it) and a job's consent (what the owner approved
 * for a scheduled job, or allowed when it was scheduled, covering its later
 * runs). Both are learned from the owner's decisions, never from what a
 * turn reads, and neither reaches past this line:
 *
 * - anything a guest's words started;
 * - what asks every time: a secret, the clipboard, a script in a page;
 * - a session on one of the owner's devices, or a step in the owner's own
 *   Chrome, where they are signed in;
 * - a delete of the owner's data: files.rm, a sql DELETE or DROP, a command
 *   that destroys;
 * - a write to KOS's own tables, which a daemon's next start may run;
 * - whatever a rule puts beyond Auto: money, deleting outside the
 *   workspace, changing KOS itself, a message to anyone but the owner. A
 *   job posts unasked only where the owner alone reads (notify's own
 *   rule); a post where guests read asks every run, since a job may read
 *   what guests wrote and be steered to post the owner's data there.
 */
export interface LearnedCall {
  tool: string;
  input: Record<string, unknown>;
  assessment: RiskAssessment;
  /** A guest's words started the work. */
  guest: boolean;
  /** The call names a secret anywhere. */
  secret: boolean;
  /** A tool of the browser's family that asks every time. */
  strict: boolean;
  /** A browser step in the owner's own Chrome. */
  yours: boolean;
}

/** Tools whose calls remove what the owner has, whatever their arguments. */
const DELETING_TOOLS = new Set(["files.rm"]);

/**
 * True when the call deletes the owner's data: a delete, a drop, a
 * truncate, a REPLACE (which deletes the row it replaces), or an UPDATE
 * with no WHERE, which overwrites every row.
 */
export function deletesData(tool: string, input: Record<string, unknown>): boolean {
  if (DELETING_TOOLS.has(tool)) return true;
  if (tool === "sql") {
    const sql = typeof input["sql"] === "string" ? input["sql"] : "";
    if (!isSqlDestructive(sql)) return false;
    if (/\b(delete|drop|truncate|replace)\b/i.test(sql)) return true;
    return /\bupdate\b/i.test(sql) && !/\bwhere\b/i.test(sql);
  }
  return false;
}

/** Whether a learned yes may cover the call: the same rules for a burst and a job's consent. */
export function learnable(call: LearnedCall): boolean {
  const { tool, input, assessment } = call;
  if (call.guest || call.secret || call.strict || call.yours) return false;
  if (assessment.asksAlways || assessment.startsSession || assessment.neverLearned || assessment.beyondAuto) return false;
  if (PRIVATE_TOOLS.includes(tool) || tool.startsWith("computer.")) return false;
  return !deletesData(tool, input);
}
