import { Count } from "@kos/kit";
import { type ReactElement, type ReactNode } from "react";

import { useEdgeFade } from "./edgefade.js";

/**
 * The top of a page: what it is, then what you can do on it.
 *
 * One component because Schedule, History, Knowledge and Agents each grew
 * their own header, with different type sizes, different search boxes and
 * the primary action in a different place on each. Moving between them read
 * as moving between four applications. Every list and reading page opens
 * with it; where the page sits in the window is `frameOf`'s (routes.ts).
 *
 * Search sits next to the actions rather than above them, and the primary
 * action is last, so the eye lands on it after reading the row. A page with
 * tabs (Memory, Runs) has them under its line, the same place on each.
 */
export function PageHead({
  title,
  count,
  subtitle,
  search,
  actions,
  tabs,
}: {
  title: string;
  /** How many the page holds, beside its title. */
  count?: number;
  subtitle?: ReactNode;
  /** A search box, where the page has something worth searching. */
  search?: ReactNode;
  /** Buttons. The primary one goes last. */
  actions?: ReactNode;
  /** The page's tabs: `PageTabs`. */
  tabs?: ReactNode;
}): ReactElement {
  return (
    <header className="list-head">
      <div className="list-head-row">
        <div className="list-head-titles">
          <h1 className="list-title">
            {title}
            {count !== undefined && <Count n={count} />}
          </h1>
          {subtitle && <p className="list-sub">{subtitle}</p>}
        </div>
        {(search || actions) && (
          <div className="list-head-tools">
            {search}
            {actions}
          </div>
        )}
      </div>
      {tabs}
    </header>
  );
}

export interface PageTab {
  id: string;
  label: ReactNode;
  /** A link for a tab that is a page of its own (Runs); none for a tab within the page (Memory). */
  href?: string;
}

/**
 * A page's tabs, under its head: links when each tab is a route of its own,
 * an ARIA tablist when they switch what one page shows. Either way the
 * same row, so Memory's tabs and Runs' are one control.
 */
export function PageTabs({
  tabs,
  current,
  label,
  onChoose,
  controls,
}: {
  tabs: readonly PageTab[];
  current: string;
  label: string;
  /** For a tablist: the tab chosen. Absent for links. */
  onChoose?: (id: string) => void;
  /** The id of the panel a tablist's tabs show. */
  controls?: string;
}): ReactElement {
  // A row that runs out of room scrolls sideways, and fades at the edge with more past it.
  const navRef = useEdgeFade<HTMLElement>();
  const listRef = useEdgeFade<HTMLDivElement>();
  if (!onChoose) {
    return (
      <nav className="page-tabs" aria-label={label} ref={navRef}>
        {tabs.map((t) => (
          <a key={t.id} href={t.href} className="page-tab" aria-current={t.id === current ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
    );
  }
  const at = Math.max(0, tabs.findIndex((t) => t.id === current));
  return (
    <div
      className="page-tabs"
      role="tablist"
      aria-label={label}
      ref={listRef}
      onKeyDown={(e) => {
        // The arrows move between tabs, Home and End to the ends; Tab goes on to what the tab shows.
        const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        const next = tabs[(to + tabs.length) % tabs.length]!;
        onChoose(next.id);
        e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={tabId(label, t.id)}
          data-tab={t.id}
          type="button"
          role="tab"
          className="page-tab"
          aria-selected={t.id === current}
          aria-controls={controls}
          tabIndex={t.id === current ? 0 : -1}
          onClick={() => onChoose(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A tablist tab's element id, for its panel's aria-labelledby. */
export const tabId = (label: string, id: string): string => `${label.toLowerCase()}-tab-${id}`;
