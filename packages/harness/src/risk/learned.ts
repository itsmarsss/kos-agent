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
 * - whatever a rule puts beyond Auto: money, deleting outside the
 *   workspace, changing KOS itself, a message to anyone but the owner.
 *
 * The one exception is a job's own consent to post in a channel: the owner
 * approved that job posting there, and the same post on its next run is
 * the job doing what it is for. A message to a person is never covered.
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

/** True when the call deletes the owner's data. */
export function deletesData(tool: string, input: Record<string, unknown>): boolean {
  if (DELETING_TOOLS.has(tool)) return true;
  if (tool === "sql") {
    const sql = typeof input["sql"] === "string" ? input["sql"] : "";
    return /\b(delete|drop|truncate)\b/i.test(sql) && isSqlDestructive(sql);
  }
  return false;
}

/** A notify to a channel, by the shape of its destination: never to a person. */
export function postsToChannel(tool: string, input: Record<string, unknown>): boolean {
  if (tool !== "notify") return false;
  const to = typeof input["to"] === "string" ? input["to"] : "";
  return /^(?:[a-z][a-z0-9_-]*:)?channel:[^:]+$/i.test(to);
}

/** Whether a learned yes of this kind may cover the call. */
export function learnable(call: LearnedCall, kind: "burst" | "job"): boolean {
  const { tool, input, assessment } = call;
  if (call.guest || call.secret || call.strict || call.yours) return false;
  if (assessment.asksAlways || assessment.startsSession) return false;
  if (PRIVATE_TOOLS.includes(tool) || tool.startsWith("computer.")) return false;
  if (deletesData(tool, input)) return false;
  if (assessment.beyondAuto) return kind === "job" && postsToChannel(tool, input);
  return true;
}
