import { join, relative, sep } from "node:path";

import { outsideHome, placePath, reachWords, ROOT_HOME, type FileHome } from "@kos/shared";

import { MAINTENANCE } from "../kernel/caretaker.js";
import type { ModuleContext } from "../modules/loader.js";
import type { Reach } from "../risk/tiers.js";
import type { Workspace } from "../store/workspace.js";

/**
 * Where a file tool's path lands for the turn calling it: from the turn's
 * home (its project's folder, its blob's, or the root), by the one rule in
 * @kos/shared/filehome, and then through the jail like every other path.
 */

/** The calling turn's home; the workspace root outside a turn. */
export function callerHome(ctx: ModuleContext): FileHome {
  return ctx.services?.callerHome?.() ?? ROOT_HOME;
}

export interface HomePath {
  /** Absolute, through the jail. */
  abs: string;
  /** Workspace-relative, "/"-separated: how a result names it. */
  rel: string;
  /** Outside every folder the turn's home owns. */
  outside: boolean;
}

/** A path as the calling turn wrote it, placed from its home and through the jail. */
export function placeFor(ws: Workspace, ctx: ModuleContext, path: string): HomePath {
  const placed = placePath(callerHome(ctx), path, ws.root);
  const abs = ws.resolve(placed.path);
  return { abs, rel: relative(ws.root, abs).split(sep).join("/"), outside: placed.outside };
}

/**
 * Where a program run for the calling turn may write, as the sandbox's write
 * scope: its own folders, the shared scratch area and the children's temp
 * folder. Undefined, the whole workspace, at the root and for Maintenance,
 * which reaches as the root does.
 */
export function writeScope(ws: Workspace, ctx: ModuleContext): string[] | undefined {
  const home = callerHome(ctx);
  if (home.folder === "" || ctx.services?.callerProject?.() === MAINTENANCE.slug) return undefined;
  return [home.folder, ...(home.also ?? []), "scratch", ".kos/tmp"].map((folder) => join(ws.root, folder));
}

/** Said to Auto for a write into another project's folder or a blob's: the owner decides those, whatever the chat's mode. */
export const INTO_ANOTHER = "writes into another project";

/** True when a workspace path is inside a project's or a blob's folder that is not one of the home's own. */
export function intoAnother(home: FileHome, path: string): boolean {
  const [top, owner] = path.toLowerCase().split("/");
  return (top === "projects" || top === "blobs") && owner !== undefined && owner !== "" && outsideHome(home, path);
}

/**
 * The reach rule for a tool that changes the paths `changes` picks from a
 * call: the first that lands outside the turn's home, so the call asks and
 * the card says where. One into another project's or a blob's folder is
 * beyond Auto; one at the workspace root is not, so a night's work in Auto
 * can still keep a file there. Maintenance reaches as the root does, so its
 * changes elsewhere are its work, not a reach.
 */
export function reachOutside(ws: Workspace, ctx: ModuleContext, changes: (input: Record<string, unknown>) => unknown[]): (input: Record<string, unknown>) => Reach | false {
  return (input) => {
    if (ctx.services?.callerProject?.() === MAINTENANCE.slug) return false;
    const home = callerHome(ctx);
    if (home.folder === "") return false;
    for (const raw of changes(input)) {
      if (typeof raw !== "string") continue;
      const placed = placePath(home, raw, ws.root);
      const why = reachWords(home, placed, "change");
      if (why) return { why, ...(intoAnother(home, placed.path) ? { beyondAuto: INTO_ANOTHER } : {}) };
    }
    return false;
  };
}
