import { PRIVATE_TOOLS } from "@kos/shared";

import { codeOf } from "../tools/fence.js";
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

/** Words that are SQL, not a column a condition could name. */
const NOT_NAMES = new Set(["and", "or", "not", "is", "null", "true", "false", "like", "glob", "in", "between", "case", "when", "then", "else", "end", "collate", "nocase"]);

/** The names a condition reads: plain words that are not SQL's, and quoted identifiers. */
function namesIn(term: string): string[] {
  return (term.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
}

/** One branch of a WHERE that holds for every row: no column read, a column against itself, or one that is merely present. */
function holdsForAll(term: string): boolean {
  const t = term.replace(/[()]/g, " ").trim();
  if (/\bis\s+not\s+null\b/i.test(t) || namesIn(t).length === 0) return true;
  const same = /^(\S+)\s*(?:==?|>=|<=|\bis\b|\blike\b|\bglob\b)\s*(\S+)$/i.exec(t);
  return same !== null && same[1]!.toLowerCase() === same[2]!.toLowerCase();
}

/**
 * Whether an UPDATE may change every row: no WHERE, or one whose branches
 * (split at OR) include one that holds for all. Read from the statement with
 * its values and comments taken out and its quoted names kept (codeOf), so
 * neither a value nor a comment can stand in for a condition.
 */
function updatesEveryRow(code: string): boolean {
  const where = /\bwhere\b([\s\S]*?)(?:\breturning\b|\border\s+by\b|\blimit\b|;|$)/i.exec(code);
  return !where || where[1]!.split(/\bor\b/i).some(holdsForAll);
}

/**
 * True when the call deletes the owner's data, judged by its words, where a
 * tool with the database (sql) judges by SQLite's plan beside this: any
 * delete, drop, truncate or replace anywhere in the raw statement (a word
 * in a value counts, which only asks), or an UPDATE that may change every
 * row.
 */
export function deletesData(tool: string, input: Record<string, unknown>): boolean {
  if (DELETING_TOOLS.has(tool)) return true;
  if (tool !== "sql") return false;
  const sql = typeof input["sql"] === "string" ? input["sql"] : "";
  if (/\b(delete|drop|truncate|replace)\b/i.test(sql)) return true;
  const code = codeOf(sql);
  return /\bupdate\b/i.test(code) && updatesEveryRow(code);
}

/** Whether a learned yes may cover the call: the same rules for a burst and a job's consent. */
export function learnable(call: LearnedCall): boolean {
  const { tool, input, assessment } = call;
  if (call.guest || call.secret || call.strict || call.yours) return false;
  if (assessment.asksAlways || assessment.startsSession || assessment.neverLearned || assessment.beyondAuto) return false;
  if (PRIVATE_TOOLS.includes(tool) || tool.startsWith("computer.")) return false;
  return !deletesData(tool, input);
}
