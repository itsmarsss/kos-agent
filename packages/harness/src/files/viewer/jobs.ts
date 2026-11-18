import { scan, type ScanResult } from "../../tools/scan.js";
import { runRequest, type ConvertRequest } from "./convert.js";

/**
 * What the viewer's child process is asked to do: convert a file (or clean
 * a document's HTML), or read text files for a contents search. Both parse
 * what anyone could have put in the workspace, and the search can take
 * seconds, so neither runs on KOS's own event loop.
 */

/** A contents search: `pattern` (a RegExp source) under `target`, paths relative to `root`, both already through the jail. */
export interface ContentsRequest {
  op: "contents";
  root: string;
  target: string;
  pattern: string;
  /** How long it may read, in ms, before it answers with what it found. */
  budgetMs: number;
  /** Top-level names not looked in (the workspace's own files). */
  skipTop: string[];
}

export type ChildRequest = ConvertRequest | ContentsRequest;

export function runJob(req: ChildRequest): unknown {
  if (req.op !== "contents") return runRequest(req);
  const skip = new Set(req.skipTop);
  const result: ScanResult = scan(req.root, req.target, req.pattern, {
    flags: "i",
    maxMatches: 400,
    deadline: Date.now() + req.budgetMs,
    skip: (p) => !p.includes("/") && skip.has(p),
  });
  return result;
}
