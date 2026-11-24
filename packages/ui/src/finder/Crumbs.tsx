import type { ReactElement, ReactNode } from "react";

import { ChevronRight } from "@kos/kit";

import type { RowHandlers } from "./rows.js";

/**
 * A path as steps on one line, cut from the left when it does not fit: the
 * outermost folders give way first, down to their mark or an ellipsis, and
 * the last step keeps its name longest. The whole path is the tooltip.
 * The toolbar's title and the path bar at the foot are both drawn with it.
 */

export interface Crumb {
  key: string;
  name: string;
  icon?: ReactNode;
  /** Absent for a step that goes nowhere: where you are, or a file. */
  go?: () => void;
  drop?: ReturnType<RowHandlers["drop"]>;
  over?: boolean;
  /** Where you are: drawn strongest. */
  here?: boolean;
}

/**
 * How much a step gives way, by its place: each further out gives far more
 * than the one inside it, so the left goes first. Far more, not a little:
 * flex shares the overflow by these factors, and at 64 times the last step
 * still took a fraction of a pixel, enough to draw "boo…" for "books" while
 * the step before it had room to give. The last is 1, not less: flex lets
 * factors summing under 1 take only that share of the overflow. Capped so
 * the browser's float holds the sum of a deep path's.
 */
const SHRINK_BASE = 1e6;
const SHRINK_MAX_POWER = 5;
export const shrinkOf = (i: number, n: number): number => SHRINK_BASE ** Math.min(n - 1 - i, SHRINK_MAX_POWER);

export function Crumbs({ items, label, className, title }: { items: Crumb[]; label: string; className: string; title: string }): ReactElement {
  return (
    <nav className={`finder-crumbs ${className}`} aria-label={label} title={title}>
      {items.map((c, i) => {
        const words = (
          <>
            {c.icon}
            <span className="finder-crumb-name">{c.name}</span>
          </>
        );
        const cls = `finder-crumb${c.here ? " is-here" : ""}${c.over ? " is-drop" : ""}`;
        return (
          <span key={c.key} className="finder-crumb-step" style={{ flexShrink: shrinkOf(i, items.length) }}>
            {i > 0 && <ChevronRight size={10} title="" />}
            {c.go ? (
              <button type="button" className={cls} onClick={c.go} {...c.drop}>
                {words}
              </button>
            ) : (
              <span className={cls} aria-current={c.here ? "location" : undefined} {...c.drop}>
                {words}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** A path as its tooltip says it: the root's name, then each folder. */
export const pathWords = (names: string[]): string => names.join(" / ");
