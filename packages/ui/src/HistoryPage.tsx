import { useMemo, useState, type ReactElement } from "react";

import { clockWords, errorWords, formatDuration, kindWord, stateOfRun, stepLine, summarizeAction } from "@kos/shared";

import { Chips, StatusPill } from "@kos/kit";

import type { AuditRecord, Conversation, CronJob, Project, RunRecord } from "./api.js";
import { ListPage } from "./ListPage.js";
import { ProjectMark } from "./ProjectMark.js";
import { RUNS_SUBTITLE, RunsTabs } from "./RunsTabs.js";
import { jobTitle } from "./schedulewords.js";

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

const FILTERS: { value: Filter; label: string; title: string }[] = [
  { value: "all", label: "Everything", title: "Every chat reply, schedule run and step" },
  { value: "runs", label: "Chats and schedules", title: "Each reply KOS gave and each time a schedule ran" },
  { value: "tools", label: "Steps", title: "Each thing KOS did along the way: read a file, fetch a page" },
  { value: "failures", label: "Failed", title: "Replies, runs and steps that went wrong" },
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

/** A run's kind as the row's tag says it: a chat's reply, a schedule's run, KOS's own work on memory. */
export function runKind(kind: string): string {
  if (kind === "chat") return "Chat";
  if (kind === "heartbeat") return "Check";
  if (kind.startsWith("memory.")) return "Memory";
  return kindWord(kind);
}

/** What KOS's own work after a turn was, in words. */
const RUN_WORDS: Readonly<Record<string, string>> = {
  heartbeat: "Heartbeat",
  "memory.events": "Logged the turn",
  "memory.facts": "Noted claims from the turn",
  "memory.extract": "Read the turn for memory",
};

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

/** A run's name, after its project's mark when it ran in a project's chat. */
function RunName({ label, project }: { label: string; project: Project | undefined }): ReactElement {
  return (
    <span className="hist-name">
      {project && <ProjectMark slug={project.slug} name={project.name} colour={project.colour} />}
      {label}
    </span>
  );
}

/** A step's row: what it did, and what to when its arguments say. */
function StepWhat({ tool, args }: { tool: string; args: unknown }): ReactElement {
  const line = stepLine(tool, args);
  return (
    <span className="hist-what" title={tool}>
      <span>{line.title}</span>
      {line.detail && <span className="ops-muted">{line.detail}</span>}
    </span>
  );
}

export function HistoryPage({
  tools,
  runs,
  crons,
  conversations = [],
  projects = [],
  onOpenTool,
  onOpenRun,
  onFix,
  loading = false,
}: {
  tools: AuditRecord[];
  runs: RunRecord[];
  /** Only to put a name to a run's job id: "cron #1" says nothing. */
  crons: CronJob[];
  /** To put a chat's title to a turn: "chat #cmwneryb72:owner" says nothing either. */
  conversations?: Conversation[];
  /** A project's chat is marked with the project. */
  projects?: Project[];
  onOpenTool: (record: AuditRecord) => void;
  onOpenRun: (record: RunRecord) => void;
  /** Put KOS on a failure, in its own chat. */
  onFix?: (row: HistoryRow) => void;
  /** The runs and steps have not been read yet. */
  loading?: boolean;
}): ReactElement {
  const [fixing, setFixing] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const jobNames = useMemo(
    () => new Map(crons.map((c) => [String(c.id), c.name])),
    [crons],
  );
  const chats = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);
  const projectOf = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);
  /** The chat a turn ran in, when it is still listed. */
  const chatOf = (r: RunRecord): Conversation | undefined => (r.kind === "chat" && r.ref ? chats.get(r.ref) : undefined);
  /** What a run was, in the words the owner gave it where there are any, never its id. */
  const runLabel = (r: RunRecord): string => {
    if (r.kind === "cron") {
      const named = r.ref ? jobNames.get(r.ref) : undefined;
      return named ? jobTitle(named) : "A job since removed";
    }
    if (r.kind === "chat") {
      const chat = chatOf(r);
      if (chat) return chat.kind === "orchestrator" ? "KOS" : chat.title || "Untitled chat";
      return r.ref?.startsWith("project:") ? (projectOf.get(r.ref.slice(8))?.name ?? "A project's chat") : "An archived or deleted chat";
    }
    return RUN_WORDS[r.kind] ?? r.kind;
  };
  /** The project a turn's chat belongs to, for its mark. */
  const markOf = (r: RunRecord): Project | undefined => {
    const slug = chatOf(r)?.projectSlug ?? (r.ref?.startsWith("project:") ? r.ref.slice(8) : undefined);
    return slug ? projectOf.get(slug) : undefined;
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
      title="Runs"
      subtitle={RUNS_SUBTITLE.history}
      stackOnPhone
      loading={loading}
      tabs={<RunsTabs current="history" />}
      rows={rows}
      rowKey={(r) => `${r.kind}-${r.kind === "tool" ? r.tool.id : r.run.id}`}
      empty="Nothing has happened yet."
      noun="runs"
      onClearFilters={() => setFilter("all")}
      groupBy={(r) => dayLabel(r.at)}
      fixedLayout
      onRowClick={(r) =>
        r.kind === "tool" ? onOpenTool(r.tool) : onOpenRun(r.run)
      }
      filters={
        <Chips options={FILTERS.map((f) => [f.value, f.label, f.title] as const)} selected={filter} onChoose={setFilter} />
      }
      columns={[
        {
          key: "kind",
          header: "",
          width: "7%",
          searchText: (r) => (r.kind === "tool" ? "Step" : runKind(r.run.kind)),
          render: (r) => (
            <span className={`hist-kind hist-kind--${r.kind}`}>
              {r.kind === "tool" ? "Step" : runKind(r.run.kind)}
            </span>
          ),
        },
        {
          key: "what",
          header: "What",
          stack: "title",
          searchText: (r) =>
            r.kind === "tool"
              ? `${stepLine(r.tool.tool, r.tool.args).title} ${summarizeAction(r.tool.tool, r.tool.args)} ${r.tool.tool}`
              : `${runLabel(r.run)} ${r.run.kind} ${r.run.error ? errorWords(r.run.error) : ""}`,
          // A step by what it did and to what; its tool and arguments are in the drawer it opens.
          render: (r) =>
            r.kind === "tool" ? (
              <StepWhat tool={r.tool.tool} args={r.tool.args} />
            ) : (
              <span className="hist-what">
                <RunName label={runLabel(r.run)} project={markOf(r.run)} />
                {r.run.error ? (
                  <span className="ops-muted">{errorWords(r.run.error)}</span>
                ) : null}
              </span>
            ),
        },
        {
          key: "status",
          header: "Status",
          width: "10%",
          searchText: (r) => (r.failed ? "failed" : "done"),
          render: (r) => <StatusPill state={r.failed ? "failed" : r.kind === "run" ? stateOfRun(r.run.status) : "ok"} />,
        },
        {
          key: "when",
          header: "When",
          width: "12%",
          render: (r) => (
            <span className="ops-muted hist-when">
              {clockWords(r.at)}
              {r.kind === "run" && r.run.durationMs ? <span className="hist-took"> · {formatDuration(r.run.durationMs)}</span> : null}
            </span>
          ),
        },
        {
          // Only on the rows that failed. A row that worked has nothing to
          // fix, and a button there would be noise on every line.
          key: "fix",
          header: "",
          stack: "aside",
          width: "10%",
          render: (r) => {
            if (!r.failed || !onFix) return null;
            const id = `${r.kind}-${r.kind === "tool" ? r.tool.id : r.run.id}`;
            return (
              <button
                type="button"
                className="btn btn--sm"
                disabled={fixing !== null}
                title="Opens a chat where KOS looks into this and tries to fix it"
                onClick={(e) => {
                  e.stopPropagation();
                  setFixing(id);
                  onFix(r);
                }}
              >
                {fixing === id ? "Starting…" : "Fix in a chat"}
              </button>
            );
          },
        },
      ]}
    />
  );
}
