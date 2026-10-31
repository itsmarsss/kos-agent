import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { ChevronRight } from "./icons.js";
import { ease } from "./motion.js";

/**
 * One section of the chats rail: a head that folds it, its count, an action
 * on the right, and the rows under it.
 *
 * The rail had a heading per kind of thing and each drew its own: an
 * uppercase label over the projects, a button for the schedules, chips for
 * the surfaces. One head for all of them, and each folds, so a workspace
 * with fifteen projects can put them away and see its chats.
 */
export function RailGroup({
  title,
  count,
  note,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  count?: number;
  /** Said in place of the count when there is something to say, like "2 running". */
  note?: string;
  open: boolean;
  /** Absent, the section stays as it is: open while a search is showing what matched. */
  onToggle?: () => void;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={`rail-group ${open ? "is-open" : ""}`}>
      <div className="rail-group-head">
        <button type="button" className="rail-group-fold" aria-expanded={open} disabled={!onToggle} onClick={onToggle}>
          <span className="rail-group-caret" aria-hidden="true">
            <ChevronRight size={12} />
          </span>
          <span className="rail-group-title">{title}</span>
          {note ? (
            <span className="rail-group-note">{note}</span>
          ) : (
            count !== undefined && count > 0 && <span className="rail-group-count">{count}</span>
          )}
        </button>
        {action}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            className="rail-group-body"
            // Clipped only while it moves: a row's menu hangs below the row,
            // and a section that always clipped cut off its last row's menu.
            initial={{ height: 0, opacity: 0, overflow: "hidden" }}
            animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
            exit={{ height: 0, opacity: 0, overflow: "hidden" }}
            transition={ease}
          >
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </section>
  );
}

const SHUT_KEY = "kos.chats.shut";

/**
 * Which rail sections the owner folded, remembered per browser. `shut` is
 * what a section starts as before the owner has touched it.
 */
export function useRailFolds(shut: readonly string[]): { isOpen: (id: string) => boolean; toggle: (id: string) => void } {
  const [folds, setFolds] = useState<Record<string, boolean>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(SHUT_KEY) ?? "{}");
      return saved && typeof saved === "object" ? (saved as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const isOpen = useCallback((id: string) => !(folds[id] ?? shut.includes(id)), [folds, shut]);
  const toggle = useCallback(
    (id: string) =>
      setFolds((now) => {
        const next = { ...now, [id]: !(now[id] ?? shut.includes(id)) };
        try {
          localStorage.setItem(SHUT_KEY, JSON.stringify(next));
        } catch {
          // Remembered for this visit only.
        }
        return next;
      }),
    [shut],
  );
  return { isOpen, toggle };
}
