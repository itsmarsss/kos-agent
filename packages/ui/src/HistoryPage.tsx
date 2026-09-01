import { useMemo, useState, type ReactElement } from "react";

import { summarizeAction } from "@kos/shared";

import type { AuditRecord, CronJob, RunRecord } from "./api.js";
import { ListPage } from "./ListPage.js";

/**
 * What KOS has done, in one place.
 *
 * This was two pages. Activity listed tool calls, Runs listed turns and
 * scheduled jobs, and both were the same table of the last hundred rows,
 * newest first, forever. Answering "what happened last night" meant reading
 * two lists and merging them by eye, and neither told you where last night
 * ended.
 *
 * One stream, then, grouped by day, with the kinds kept distinguishable
 * rather than blended: a tool call and a run are different sizes of thing,
 * and pretending otherwise would lose the fact that one happens inside the
 * other.
 */

export type HistoryRow =
  | { kind: "tool"; at: number; failed: boolean; tool: AuditRecord }
  | { kind: "run"; at: number; failed: boolean; run: RunRecord };

/** Which slice of history is on screen. */
type Filter = "all" | "tools" | "runs" | "failures";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "everything" },
  { value: "tools", label: "tools" },
  { value: "runs", label: "runs" },
  { value: "failures", label: "failures" },
];

const DAY = 86_400_000;

/** Midnight local, so "today" means the calendar day and not 24 hours. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** "Today", "Yesterday", "Tuesday", then a date once the weekday repeats. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY.format(ts);
  return DATE.format(ts);
}

function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Merge the two streams into one, newest first. */
export function merge(
  tools: AuditRecord[],
  runs: RunRecord[],
): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...tools.map(
      (t): HistoryRow => ({
        kind: "tool",
        at: t.createdAt,
        failed: t.isError,
        tool: t,
      }),
    ),
    ...runs.map(
      (r): HistoryRow => ({
        kind: "run",
        at: r.startedAt,
        failed: r.status === "error",
        run: r,
      }),
    ),
  ];
  return rows.sort((a, b) => b.at - a.at);
}

export function HistoryPage({
  tools,
  runs,
  crons,
  onOpenTool,
  onOpenRun,
}: {
  tools: AuditRecord[];
  runs: RunRecord[];
  /** Only to put a name to a run's job id: "cron #1" says nothing. */
  crons: CronJob[];
  onOpenTool: (record: AuditRecord) => void;
  onOpenRun: (record: RunRecord) => void;
}): ReactElement {
  const [filter, setFilter] = useState<Filter>("all");
  const jobNames = useMemo(
    () => new Map(crons.map((c) => [String(c.id), c.name])),
    [crons],
  );
  /** What a run was, in the words the owner gave it where there are any. */
  const runLabel = (r: RunRecord): string => {
    const named = r.ref ? jobNames.get(r.ref) : undefined;
    if (named) return named;
    return r.ref ? `${r.kind} #${r.ref}` : r.kind;
  };

  const rows = useMemo(() => {
    const all = merge(tools, runs);
    if (filter === "tools") return all.filter((r) => r.kind === "tool");
    if (filter === "runs") return all.filter((r) => r.kind === "run");
    if (filter === "failures") return all.filter((r) => r.failed);
    return all;
  }, [tools, runs, filter]);

  return (
    <ListPage
      title="History"
      subtitle="Everything KOS has done, newest first."
      rows={rows}
      rowKey={(r) => `${r.kind}-${r.kind === "tool" ? r.tool.id : r.run.id}`}
      empty="Nothing has happened yet"
      groupBy={(r) => dayLabel(r.at)}
      fixedLayout
      onRowClick={(r) =>
        r.kind === "tool" ? onOpenTool(r.tool) : onOpenRun(r.run)
      }
      filters={
        <div className="list-filter-group">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`ops-btn ${filter === f.value ? "ops-btn--primary" : ""}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
      columns={[
        {
          key: "kind",
          header: "",
          width: "7%",
          searchText: (r) => (r.kind === "tool" ? "tool" : `run ${r.run.kind}`),
          render: (r) => (
            <span className={`hist-kind hist-kind--${r.kind}`}>
              {r.kind === "tool" ? "tool" : r.run.kind}
            </span>
          ),
        },
        {
          key: "what",
          header: "What",
          searchText: (r) =>
            r.kind === "tool"
              ? `${r.tool.tool} ${summarizeAction(r.tool.tool, r.tool.args)}`
              : `${runLabel(r.run)} ${r.run.kind} ${r.run.error ?? ""}`,
          render: (r) =>
            r.kind === "tool" ? (
              <span className="hist-what">
                <span className="ops-mono">{r.tool.tool}</span>
                <span className="ops-muted">
                  {summarizeAction(r.tool.tool, r.tool.args)}
                </span>
              </span>
            ) : (
              <span className="hist-what">
                <span>{runLabel(r.run)}</span>
                {r.run.error ? (
                  <span className="ops-muted">{r.run.error}</span>
                ) : null}
              </span>
            ),
        },
        {
          key: "status",
          header: "Status",
          width: "10%",
          searchText: (r) => (r.failed ? "error failed" : "ok"),
          render: (r) =>
            r.failed ? (
              <span className="ops-tag ops-tag--danger">error</span>
            ) : r.kind === "run" && r.run.status === "skipped" ? (
              <span className="ops-tag ops-tag--muted">skipped</span>
            ) : (
              <span className="ops-tag ops-tag--ok">ok</span>
            ),
        },
        {
          key: "when",
          header: "When",
          width: "12%",
          render: (r) => (
            <span className="ops-muted">
              {timeOfDay(r.at)}
              {r.kind === "run" && r.run.durationMs ? (
                <span className="hist-took">
                  {" · "}
                  {Math.round(r.run.durationMs / 100) / 10}s
                </span>
              ) : null}
            </span>
          ),
        },
      ]}
    />
  );
}
