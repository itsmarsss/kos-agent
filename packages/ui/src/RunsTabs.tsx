import type { ReactElement, ReactNode } from "react";

import { hrefFor, type Route } from "./routes.js";

/**
 * Agents, Schedule and History under one heading.
 *
 * All three are what KOS does on its own: sub-agents it ran, jobs it will
 * run, and the record of what happened. None is a daily visit, and each
 * took a slot in a nav that had run out of them. They keep their own routes
 * and pages; this is the strip that says they are siblings.
 */
const TABS: { route: Route; label: string }[] = [
  { route: { name: "history" }, label: "History" },
  { route: { name: "crons" }, label: "Schedule" },
  { route: { name: "agents" }, label: "Agents" },
];

export function RunsTabs({ current, children }: { current: Route["name"]; children: ReactNode }): ReactElement {
  return (
    <div className="runs">
      <nav className="runs-tabs" aria-label="Runs">
        {TABS.map((t) => (
          <a
            key={t.label}
            href={hrefFor(t.route)}
            className={`runs-tab${t.route.name === current ? " is-active" : ""}`}
            aria-current={t.route.name === current ? "page" : undefined}
          >
            {t.label}
          </a>
        ))}
      </nav>
      {children}
    </div>
  );
}
