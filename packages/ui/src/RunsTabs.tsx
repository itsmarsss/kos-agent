import type { ReactElement } from "react";

import { PageTabs } from "./PageHead.js";
import { hrefFor, type Route } from "./routes.js";

/**
 * History, Schedule and Builds under one heading.
 *
 * All three are what KOS does on its own: sub-agents it ran, jobs it will
 * run, and the record of what happened. None is a daily visit, and each
 * took a slot in a nav that had run out of them. They keep their own routes
 * and pages; these are the tabs, in each page's head, that say they are
 * siblings.
 */
const TABS: { route: Route; label: string }[] = [
  { route: { name: "history" }, label: "History" },
  { route: { name: "crons" }, label: "Schedule" },
  { route: { name: "builds" }, label: "Builds" },
];

export function RunsTabs({ current }: { current: Route["name"] }): ReactElement {
  return <PageTabs label="Runs" current={current} tabs={TABS.map((t) => ({ id: t.route.name, label: t.label, href: hrefFor(t.route) }))} />;
}
