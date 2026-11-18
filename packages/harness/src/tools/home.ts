import { relative, sep } from "node:path";

import { placePath, reachWords, ROOT_HOME, type FileHome } from "@kos/shared";

import { MAINTENANCE } from "../kernel/caretaker.js";
import type { ModuleContext } from "../modules/loader.js";
import type { Escalation } from "../risk/tiers.js";
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
 * The reach rule for a tool that changes the paths `changes` picks from a
 * call: the words for the first that lands outside the turn's home, so the
 * call asks and the card says where. Maintenance reaches as the root does,
 * so its changes elsewhere are its work, not a reach.
 */
export function reachOutside(ws: Workspace, ctx: ModuleContext, changes: (input: Record<string, unknown>) => unknown[]): Escalation {
  return (input) => {
    if (ctx.services?.callerProject?.() === MAINTENANCE.slug) return false;
    const home = callerHome(ctx);
    if (home.folder === "") return false;
    for (const raw of changes(input)) {
      if (typeof raw !== "string") continue;
      const words = reachWords(home, placePath(home, raw, ws.root), "change");
      if (words) return words;
    }
    return false;
  };
}
