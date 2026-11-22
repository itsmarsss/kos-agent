import type { CSSProperties } from "react";

import { splitExtension } from "./names.js";

/**
 * How far a row of a folder opened in place steps in. The first levels each
 * step a whole `--finder-indent`; deeper ones a fraction of it. styles.css
 * then holds the step to what the Name column can spare, one step for the
 * whole list so a parent's triangle and its children's guide line up: the
 * deepest row in no further than a quarter of the column, and never so far
 * that a name has less room than it keeps. A faint guide under a row's
 * parent's triangle keeps the levels apart where the steps are small.
 */

/** Levels that step a whole indent. */
export const FULL_LEVELS = 3;
/** What each level past those steps, as a share of a whole one. */
export const DEEP_STEP = 0.4;
/** The characters of a cut name always kept in sight, its extension and the ellipsis besides. */
export const NAME_KEEP = 8;

/** A row's indent in steps: one a level for the first levels, a fraction for each past them. */
export function indentUnits(depth: number): number {
  return Math.min(depth, FULL_LEVELS) + Math.max(0, depth - FULL_LEVELS) * DEEP_STEP;
}

/** How many characters wide a name needs its room to be: all of a short one, or the kept start and end, the ellipsis and the extension. */
export function keptChars(name: string, isFile: boolean): number {
  const [, ext] = splitExtension(name, isFile);
  return Math.min(name.length, NAME_KEEP + 1 + ext.length);
}

interface TreeRow {
  depth: number;
  entry: { name: string; kind: string };
}

/**
 * The list's bounds on its step, as styles.css reads them: `--finder-units`,
 * the deepest row's indent in steps, and `--finder-keep`, the widest room
 * any indented name keeps. None for a flat list.
 */
export function treeStyle(rows: readonly TreeRow[]): CSSProperties {
  let units = 0;
  let keep = 0;
  for (const { depth, entry } of rows) {
    if (depth === 0) continue;
    units = Math.max(units, indentUnits(depth));
    keep = Math.max(keep, keptChars(entry.name, entry.kind === "file"));
  }
  return units ? ({ "--finder-units": units, "--finder-keep": `${keep}ch` } as CSSProperties) : {};
}

/** A row's level in steps, or its guide's (its parent's), as `--finder-level`. */
export const levelStyle = (depth: number): CSSProperties => ({ "--finder-level": indentUnits(depth) }) as CSSProperties;
