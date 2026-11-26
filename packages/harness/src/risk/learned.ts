import { PRIVATE_TOOLS } from "@kos/shared";

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

/** The statement with its string literals emptied and its comments gone, so neither can pass for a keyword. */
function bare(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
}

/** Words that are SQL, not a column a condition could name. */
const NOT_NAMES = new Set(["and", "or", "not", "is", "null", "true", "false", "like", "glob", "in", "between", "case", "when", "then", "else", "end", "collate", "nocase"]);

/**
 * Whether an UPDATE names the rows it changes: a WHERE whose condition
 * reads a column. `WHERE 1 = 1` or `WHERE 'a' = 'a'` names none.
 */
function namesRows(statement: string): boolean {
  const where = /\bwhere\b([\s\S]*?)(?:\breturning\b|\border\s+by\b|\blimit\b|;|$)/i.exec(statement);
  if (!where) return false;
  const condition = where[1]!.replace(/''/g, " ");
  if (/["`[]/.test(condition)) return true;
  return (condition.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((word) => !NOT_NAMES.has(word.toLowerCase()));
}

/**
 * True when the call deletes the owner's data: a delete, a drop, a
 * truncate, a REPLACE or an UPDATE OR REPLACE (which delete the rows they
 * replace), or an UPDATE whose WHERE names no rows, which overwrites every
 * one. Read with strings and comments taken out.
 */
export function deletesData(tool: string, input: Record<string, unknown>): boolean {
  if (DELETING_TOOLS.has(tool)) return true;
  if (tool !== "sql") return false;
  const sql = bare(typeof input["sql"] === "string" ? input["sql"] : "");
  if (/\b(delete\s+from|drop\s+(table|index|view|trigger)|truncate|replace\s+into|or\s+replace)\b/i.test(sql)) return true;
  return /\bupdate\b/i.test(sql) && !namesRows(sql);
}

/** Whether a learned yes may cover the call: the same rules for a burst and a job's consent. */
export function learnable(call: LearnedCall): boolean {
  const { tool, input, assessment } = call;
  if (call.guest || call.secret || call.strict || call.yours) return false;
  if (assessment.asksAlways || assessment.startsSession || assessment.neverLearned || assessment.beyondAuto) return false;
  if (PRIVATE_TOOLS.includes(tool) || tool.startsWith("computer.")) return false;
  return !deletesData(tool, input);
}
