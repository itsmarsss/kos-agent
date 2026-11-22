import type { KeyboardEvent } from "react";

/**
 * A row that opens something, reachable by keys: one Tab stop for the row,
 * Enter or Space opens it, and the arrows (Home and End too) walk to the
 * rows beside it. A row is found among its kin: every `[data-row]` inside the
 * nearest `[data-rows]`, or inside its parent when there is none, so a table
 * whose group heads sit between its rows still walks straight through them.
 *
 * A key pressed on a control inside the row (a Fix button, a Run now) is the
 * control's: the row only answers keys pressed on itself.
 */
export interface RowKeyProps {
  tabIndex: 0;
  "data-row": "";
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

const STEPS: Record<string, "next" | "previous" | "first" | "last"> = {
  ArrowDown: "next",
  ArrowUp: "previous",
  Home: "first",
  End: "last",
};

/** The row to go to from `from`, or null when there is none that way. */
export function rowBeside(from: HTMLElement, step: "next" | "previous" | "first" | "last"): HTMLElement | null {
  const scope = from.closest<HTMLElement>("[data-rows]") ?? from.parentElement;
  if (!scope) return null;
  const rows = [...scope.querySelectorAll<HTMLElement>("[data-row]")];
  if (rows.length === 0) return null;
  if (step === "first") return rows[0]!;
  if (step === "last") return rows[rows.length - 1]!;
  const at = rows.indexOf(from);
  return rows[at + (step === "next" ? 1 : -1)] ?? null;
}

export function rowKeys(open: () => void): RowKeyProps {
  return {
    tabIndex: 0,
    "data-row": "",
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
        return;
      }
      const step = STEPS[e.key];
      if (!step) return;
      const to = rowBeside(e.currentTarget, step);
      if (!to) return;
      e.preventDefault();
      to.focus();
    },
  };
}
