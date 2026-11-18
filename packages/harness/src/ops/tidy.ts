import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { LAYOUT_FOLDERS } from "@kos/shared";

import { MAINTENANCE } from "../kernel/caretaker.js";
import { RESERVED, uniqueName } from "../kernel/files.js";
import type { Workspace } from "../store/workspace.js";
import { ensureAuditSchema } from "./audit.js";

/**
 * Putting a project's files back in its folder.
 *
 * Before a turn had a home folder, a project's chat that wrote
 * "bu252/notes.md" wrote it at the workspace root. This finds such files
 * and proposes where each belongs; nothing moves until the owner says so,
 * and nothing is overwritten. A file belongs to a project when it sits in a
 * root folder named for that project (school/ for the school project), or
 * when the audit log shows it was written while only that project's turns
 * were running. Anything else is left where it is.
 */

/** Top-level names that are KOS's own layout, never a project's misplaced work. */
const KEPT = new Set([...LAYOUT_FOLDERS, ...RESERVED, "uploads", "downloads", "artifacts", "modules", "library"]);

/** Tools whose path argument is a file the call wrote, by the argument that names it. */
const WRITES: Record<string, string> = {
  "files.write": "path",
  "files.edit": "path",
  "files.cp": "to",
  "files.mv": "to",
  "export.query": "path",
};

export interface TidyMove {
  /** Workspace-relative, where it is now. */
  from: string;
  /** Workspace-relative, where it would go: under projects/<project>/. */
  to: string;
  project: string;
  /** "named": in a root folder named for the project; "written": the audit log puts its writing in the project's turns. */
  why: "named" | "written";
}

export interface TidyPlan {
  moves: TidyMove[];
  /** Files under the root's other folders that no project can be told for, and why: listed, never moved. */
  unknown: { path: string; why: string }[];
}

export interface TidyResult {
  /** Where each file went; a clash was given another name. */
  moved: { from: string; to: string }[];
  /** Left where they were, and why. */
  skipped: { from: string; why: string }[];
  /** Moves that went wrong, with the error; the rest of the plan still ran. */
  failed: { from: string; why: string }[];
}

/** Every file under a workspace folder, workspace-relative; links are not followed or listed. */
function filesUnder(ws: Workspace, rel: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ws.root, rel))) {
    const path = `${rel}/${name}`;
    const stat = lstatSync(join(ws.root, path));
    if (stat.isDirectory()) out.push(...filesUnder(ws, path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

/** The root's own folders that could hold a project's work: not KOS's layout, not hidden. */
function rootFolders(ws: Workspace): string[] {
  return readdirSync(ws.root).filter((name) => !name.startsWith(".") && !KEPT.has(name.toLowerCase()) && lstatSync(join(ws.root, name)).isDirectory());
}

/** What a file tool's result says it wrote ("wrote projects/school/x.md"), since a turn's home placed the path. */
const SAID = /^(?:wrote|edited|copied to|moved to) (.+)$/;

/** The workspace path an audited write landed on: as its result names it, else as its arguments wrote it. */
function writtenPath(row: { tool: string; args: string; result: string }): string | undefined {
  const said = SAID.exec(row.result)?.[1];
  if (said) return said;
  try {
    const path = (JSON.parse(row.args) as Record<string, unknown>)[WRITES[row.tool]!];
    return typeof path === "string" ? path : undefined;
  } catch {
    return undefined;
  }
}

/** A run never marked finished (the host went down under it) is taken to have covered at most this long. */
const LONGEST_RUN_MS = 60 * 60 * 1000;

/** How much later than its audited write a file may have been touched and still be that write's. */
const WRITE_SLACK_MS = 2000;

/**
 * Whose turns last wrote a path, and when. A project's writer moves the file
 * there; a known writer that is no project's (a root chat, Maintenance)
 * keeps it where it is even in a folder named for a project; an unknown one
 * leaves the folder's name to decide.
 */
type Writer = { at: number; fromLog: boolean } & ({ project: string } | { why: string; known: boolean });

interface AuditRow {
  tool: string;
  args: string;
  result: string;
  at: number;
  conversation: string | null;
  project: string | null;
  title: string | null;
}

/**
 * Whose turns wrote each path. Rows that carry their conversation say so
 * outright. Older rows are read against the runs going at the time: a write
 * is a project's only when every chat or job running then was that
 * project's. The latest write of a path wins.
 */
function writers(ws: Workspace, projects: Set<string>): Map<string, Writer> {
  const rows = ws.db
    .prepare(
      `SELECT a.tool, a.args, a.result, a.created_at AS at, a.conversation_id AS conversation, c.project_slug AS project, c.title AS title
         FROM audit_log a LEFT JOIN conversations c ON c.id = a.conversation_id
        WHERE a.is_error = 0 AND a.tool IN (${Object.keys(WRITES).map(() => "?").join(", ")}) ORDER BY a.id`,
    )
    .all(...Object.keys(WRITES)) as AuditRow[];
  const running = ws.db.prepare(
    `SELECT CASE r.kind WHEN 'chat' THEN c.project_slug ELSE j.project_slug END AS project, c.title AS title
       FROM runs_log r
       LEFT JOIN conversations c ON r.kind = 'chat' AND c.id = r.ref
       LEFT JOIN crons j ON r.kind = 'cron' AND CAST(j.id AS TEXT) = r.ref
      WHERE r.ref IS NOT NULL AND r.started_at <= @at
        AND (r.finished_at >= @at OR (r.finished_at IS NULL AND r.started_at >= @at - ${LONGEST_RUN_MS}))`,
  );
  /** One writer's turns, as a Writer: a project's to move to, or a known reason it stays. */
  const of = (project: string | null, title: string | null, at: number, fromLog: boolean): Writer => {
    if (project && projects.has(project) && project !== MAINTENANCE.slug) return { at, fromLog, project };
    if (project) return { at, fromLog, why: `written by ${project}, which reaches as the root does`, known: true };
    return { at, fromLog, why: `written by the root chat "${title ?? "a job"}"`, known: true };
  };
  const out = new Map<string, Writer>();
  for (const row of rows) {
    const path = writtenPath(row);
    if (path === undefined) continue;
    const key = path.replace(/\\/g, "/").replace(/^\.?\/+/, "");
    if (row.conversation) {
      out.set(key, of(row.project, row.title, row.at, true));
      continue;
    }
    const runs = running.all({ at: row.at }) as { project: string | null; title: string | null }[];
    const owners = new Set(runs.map((r) => r.project ?? ""));
    const [only] = owners;
    if (owners.size === 1 && (only !== "" || runs.length === 1)) out.set(key, of(only || null, runs[0]!.title, row.at, false));
    else out.set(key, { at: row.at, fromLog: false, why: owners.size ? "written while several chats ran" : "no record of what wrote it", known: false });
  }
  return out;
}

/**
 * A writer read from the runs, held to the file as it is: a file touched
 * after that write may be some other turn's work since, so it is nobody's
 * to move. A writer the log names outright stands.
 */
function trusted(ws: Workspace, path: string, writer: Writer | undefined): Writer | undefined {
  if (!writer || writer.fromLog) return writer;
  const changed = statSync(join(ws.root, path)).mtimeMs;
  return changed <= writer.at + WRITE_SLACK_MS ? writer : { at: writer.at, fromLog: false, why: "changed since its last recorded write", known: false };
}

/** Where a root file goes in a project: "school/x" from the school project is projects/school/x, never projects/school/school/x. */
function destination(path: string, project: string): string {
  const [top, ...rest] = path.split("/");
  return `projects/${project}/${top?.toLowerCase() === project.toLowerCase() ? rest.join("/") : path}`;
}

/** What tidying would move, without moving anything. */
export function planTidy(ws: Workspace): TidyPlan {
  // A workspace the host has not opened since conversation_id was added is read as it will be.
  ensureAuditSchema(ws.db);
  const slugs = (ws.db.prepare("SELECT slug FROM manifest").all() as { slug: string }[]).map((r) => r.slug);
  const projects = new Set(slugs);
  const named = new Map(slugs.map((slug) => [slug.toLowerCase(), slug]));
  const written = writers(ws, projects);
  const moves: TidyMove[] = [];
  const unknown: TidyPlan["unknown"] = [];
  for (const folder of rootFolders(ws)) {
    const owner = named.get(folder.toLowerCase());
    for (const from of filesUnder(ws, folder)) {
      const writer = trusted(ws, from, written.get(from));
      if (writer && "project" in writer) moves.push({ from, to: destination(from, writer.project), project: writer.project, why: "written" });
      else if (writer?.known) unknown.push({ path: from, why: writer.why });
      else if (owner) moves.push({ from, to: destination(from, owner), project: owner, why: "named" });
      else unknown.push({ path: from, why: writer?.why ?? "no record of what wrote it" });
    }
  }
  return { moves, unknown };
}

/** Remove the folders a move left empty, from `dir` up to the root's own folder. */
function pruneEmpty(ws: Workspace, dir: string): void {
  for (let at = dir; at !== "." && at !== ""; at = dirname(at)) {
    const abs = ws.resolve(at);
    if (!existsSync(abs) || readdirSync(abs).length > 0) return;
    rmdirSync(abs);
  }
}

/**
 * Carry out a plan the owner agreed to. Each move is checked again as it
 * happens: a file gone since the plan is skipped, the same file already at
 * its place is left for the owner, and a different one there makes this one
 * take a free name beside it. Folders merge; nothing is overwritten or deleted.
 */
export function applyTidy(ws: Workspace, plan: TidyPlan): TidyResult {
  const result: TidyResult = { moved: [], skipped: [], failed: [] };
  for (const move of plan.moves) {
    try {
      const from = ws.resolve(move.from);
      if (!existsSync(from)) {
        result.skipped.push({ from: move.from, why: "no longer there" });
        continue;
      }
      let to = move.to;
      const target = ws.resolve(to);
      if (existsSync(target)) {
        if (lstatSync(target).isFile() && readFileSync(target).equals(readFileSync(from))) {
          result.skipped.push({ from: move.from, why: `the same file is already at ${to}` });
          continue;
        }
        to = `${dirname(to)}/${uniqueName(ws, dirname(to), basename(to))}`;
      }
      mkdirSync(dirname(ws.resolve(to)), { recursive: true });
      renameSync(from, ws.resolve(to));
      result.moved.push({ from: move.from, to });
      pruneEmpty(ws, dirname(move.from));
    } catch (err) {
      // One move that fails (a link in the way, a folder where a file goes) leaves the others to run.
      result.failed.push({ from: move.from, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** A plan in lines the owner reads before saying yes, grouped by project. */
export function describeTidy(plan: TidyPlan): string {
  if (plan.moves.length === 0 && plan.unknown.length === 0) return "Nothing to tidy: no project's files are loose at the workspace root.";
  const lines: string[] = [];
  for (const project of [...new Set(plan.moves.map((m) => m.project))].sort()) {
    lines.push(`Into projects/${project}/:`);
    for (const m of plan.moves.filter((x) => x.project === project)) lines.push(`  ${m.from} -> ${m.to}${m.why === "named" ? "" : " (written by its chats)"}`);
  }
  if (plan.unknown.length) {
    lines.push("Left where they are (no project could be told for them):");
    for (const left of plan.unknown) lines.push(`  ${left.path} (${left.why})`);
  }
  return lines.join("\n");
}
