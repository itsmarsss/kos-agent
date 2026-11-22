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

/**
 * What each tab holds, as its page's line under the title: one sentence per
 * tab, each naming the other two, so a newcomer on any of them learns where
 * the schedules and the record are.
 */
export const RUNS_SUBTITLE: Readonly<Record<"history" | "crons" | "builds", string>> = {
  history: "Everything KOS did, newest first: each message's steps and each schedule's runs. Schedules and Builds are the tabs beside this.",
  crons: "What KOS runs on its own, on a timer you set. New schedule adds one; press one to change it. What each run did is under History.",
  builds: "Coding work KOS does in a folder of its own; any command outside that folder asks you first. What it did is under History.",
};

export function RunsTabs({ current }: { current: Route["name"] }): ReactElement {
  return <PageTabs label="Runs" current={current} tabs={TABS.map((t) => ({ id: t.route.name, label: t.label, href: hrefFor(t.route) }))} />;
}
