import type { ReactElement } from "react";
import type { HomePanel } from "@kos/shared";
import { summarizeAction } from "@kos/shared";

import type { FailingJob, HomeData, ModelSpend, RunRecord } from "./api.js";
import { clockLabel, dayLabel, hourLabel, padDays, padHours } from "./chartdata.js";
import { Bars, DayLine, ProjectMap, Share, Ticks, type Tick, type Tone } from "./charts.js";
import { Decision } from "./Decision.js";
import { hrefFor } from "./routes.js";

/**
 * The panels a home page can be built from.
 *
 * Each answers one question, and each says plainly when the answer is nothing.
 * An empty panel that renders as blank space reads as broken; one that says
 * "nothing is running" reads as an answer, and that difference is most of what
 * makes a dashboard trustworthy.
 */

type Go = (to: "agents" | "history" | "projects" | "crons" | "chats" | "settings" | "memory", section?: string) => void;

function ago(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function Head({
  title,
  count,
  onMore,
}: {
  title: string;
  count?: number;
  onMore?: () => void;
}): ReactElement {
  return (
    <header className="panel-head">
      <h2>{title}</h2>
      {count !== undefined && count > 0 && <span className="panel-count">{count}</span>}
      {onMore && (
        <button type="button" className="link panel-more" onClick={onMore}>
          All →
        </button>
      )}
    </header>
  );
}

function Empty({ children }: { children: string }): ReactElement {
  return <p className="panel-empty">{children}</p>;
}

function fmt(n: number): string {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

const RUN_TONE: Record<string, Tone> = { ok: "ok", error: "danger", running: "accent", skipped: "muted" };

/** One run as a tick: its colour is its outcome, its title the rest. */
function runTick(r: RunRecord): Tick {
  const what = r.ref ? `${r.kind} ${r.ref}` : r.kind;
  const how = r.error ? `${r.status}: ${r.error}` : r.status;
  return { tone: RUN_TONE[r.status] ?? "muted", title: `${what} · ${how} · ${ago(r.startedAt)} ago` };
}

const SHARE_TONES: Tone[] = ["accent", "ok", "warn", "muted"];

/** The models by share of tokens, the long tail folded into "other". */
function modelShares(models: ModelSpend[]): { label: string; value: number; tone: Tone }[] {
  const sorted = [...models].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  const top = sorted.slice(0, SHARE_TONES.length - (sorted.length > SHARE_TONES.length ? 1 : 0));
  const rest = sorted.slice(top.length).reduce((n, m) => n + m.inputTokens + m.outputTokens, 0);
  return [
    ...top.map((m, i) => ({ label: m.model, value: m.inputTokens + m.outputTokens, tone: SHARE_TONES[i]! })),
    ...(rest > 0 ? [{ label: "other", value: rest, tone: "muted" as Tone }] : []),
  ];
}

export function Panel({
  panel,
  data,
  editing,
  onChange,
  onOpenChat,
  onGo,
  onDecide,
  deciding,
  onDismissFailure,
  onOpenFailure,
  onFixFailure,
}: {
  panel: HomePanel;
  data: HomeData;
  editing: boolean;
  onChange: (change: Partial<HomePanel>) => void;
  onOpenChat: (id: string) => void;
  onGo: Go;
  onDecide: (id: number, approved: boolean, remember?: boolean) => void;
  deciding: ReadonlySet<number>;
  /** Stop reporting a failure the owner has dealt with. */
  onDismissFailure: (key: string) => void;
  /** Open whatever a failure belongs to. */
  onOpenFailure: (key: string) => void;
  /** Put KOS on a failure, in its own chat. */
  onFixFailure: (failure: FailingJob) => void;
}): ReactElement {
  const limit = panel.limit ?? 8;
  const title = panel.title;

  switch (panel.kind) {
    case "approvals": {
      const rows = data.approvals;
      const decisions = data.memory.decisions;
      return (
        <div className="panel panel--attention">
          <Head title={title ?? "Needs you"} count={rows.length + decisions} />
          {decisions > 0 && (
            /* Memory's open questions count as waiting on you too; they are
               answered on the Memory page, where the claims are. */
            <button type="button" className="panel-row panel-approval-memory" onClick={() => onGo("memory")}>
              <span className="panel-row-main">
                {decisions === 1 ? "A memory decision" : `${decisions} memory decisions`}: what to keep, what to promote
              </span>
              <span className="panel-row-side">Decide →</span>
            </button>
          )}
          {rows.length === 0 ? (
            decisions === 0 && <Empty>Nothing is waiting on you.</Empty>
          ) : (
            <ul className="panel-list">
              {rows.slice(0, limit).map((a) => (
                <li key={a.id} className="panel-approval">
                  <span className="panel-row-main">
                    {summarizeAction(a.tool, a.args)}
                    <code className="panel-approval-tool">{a.tool}</code>
                  </span>
                  {/* Decided here rather than somewhere else: this panel
                      exists because something is waiting, and sending the
                      owner elsewhere to answer defeats it. */}
                  <span className="panel-approval-actions">
                    <Decision id={a.id} deciding={deciding} onDecide={onDecide} small />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    case "agents": {
      const live = data.agents.filter(
        (b) => b.status === "running" || b.status === "waiting",
      );
      return (
        <div className="panel">
          <Head
            title={title ?? "Agents"}
            count={live.length}
            onMore={() => onGo("agents")}
          />
          {data.agents.length === 0 ? (
            <Empty>No coding agents have run.</Empty>
          ) : live.length === 0 ? (
            <Empty>Nothing running now.</Empty>
          ) : (
            <ul className="panel-list">
              {live.slice(0, limit).map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className="panel-row"
                    onClick={() => onGo("agents")}
                  >
                    <span className={`agent-dot agent-dot--${b.status}`} />
                    <span className="panel-row-main">{b.dir}</span>
                    <span className="panel-row-side">
                      {b.quietFor
                        ? "quiet"
                        : b.status === "waiting"
                          ? "waiting on you"
                          : "working"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    case "failures": {
      // What is broken now, rather than the last ten error rows ever recorded.
      // A job that failed once on Tuesday and has worked since is not a
      // problem, and listing it alongside one that has been failing all week
      // makes the real one harder to find.
      const report = data.health;
      const rows = report.failing.slice(0, limit);
      const rate = report.recent.total > 0 ? report.recent.rate : 0;
      return (
        <div className={`panel ${rows.length ? "panel--bad" : ""}`}>
          <Head
            title={title ?? "What broke"}
            count={report.failing.length}
            onMore={() => onGo("history")}
          />
          {rows.length === 0 ? (
            <Empty>
              {report.recent.total === 0
                ? "Nothing has run yet."
                : "Everything is working."}
            </Empty>
          ) : (
            <ul className="panel-list">
              {rows.map((f) => (
                <li key={f.key}>
                  {/* The label opens the job; the actions sit beside it as
                      siblings. Wrapping the whole row in a button put these
                      buttons inside a button, which is invalid, and the
                      browser un-nests it: Fix then also opened the editor. */}
                  <span className="panel-row is-error">
                    <button
                      type="button"
                      className="panel-row-open"
                      onClick={() => onOpenFailure(f.key)}
                    >
                      <span className="fail-label">{f.label}</span>
                      <span className="fail-why">{f.error ?? "failed"}</span>
                    </button>
                    <span className="panel-row-side">
                      {f.streak > 1 ? `${f.streak}x · ` : ""}
                      {ago(f.since)}
                      {/* Without this the only way to clear a failure the
                          owner has already handled is to wait for the job to
                          succeed, which for a nightly job means a red header
                          until tomorrow. */}
                      <button
                        type="button"
                        className="btn btn--sm"
                        title="Open a chat where KOS looks into this"
                        onClick={() => onFixFailure(f)}
                      >
                        Fix
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn--bare"
                        title="Dismiss"
                        onClick={() => onDismissFailure(f.key)}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          aria-hidden="true"
                        >
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.runs.length > 0 && (
            /* The last runs in order, oldest on the left, so a bad patch
               reads as a bad patch and a lone red tick as a lone one. */
            <Ticks items={[...data.runs].reverse().map(runTick)} />
          )}
          {report.recent.total > 0 && (
            // Labelled, because the count in the header is jobs broken right
            // now and this is runs over time: "What broke 1" above "5 of the
            // last 100 failed" read as a contradiction.
            <p className="panel-foot panel-foot--chart">
              Failure rate: {report.recent.errors} of the last{" "}
              {report.recent.total} runs ({Math.round(rate * 100)}%)
            </p>
          )}
        </div>
      );
    }

    case "pulse": {
      const hours = padHours(data.pulse, 24);
      const calls = hours.reduce((n, h) => n + h.calls, 0);
      const errors = hours.reduce((n, h) => n + h.errors, 0);
      return (
        <div className="panel">
          <Head title={title ?? "Last 24 hours"} onMore={() => onGo("history")} />
          {calls === 0 ? (
            <Empty>Nothing ran in the last day.</Empty>
          ) : (
            <>
              <Bars
                labelEvery={6}
                bars={hours.map((h) => ({
                  label: hourLabel(h.hour),
                  title: `${hourLabel(h.hour)}: ${h.calls} ${h.calls === 1 ? "call" : "calls"}${h.errors ? `, ${h.errors} failed` : ""}`,
                  parts: [
                    { value: h.calls - h.errors, tone: "accent" },
                    { value: h.errors, tone: "danger" },
                  ],
                }))}
              />
              <p className="panel-foot panel-foot--chart">
                {calls} tool {calls === 1 ? "call" : "calls"}
                {errors ? `, ${errors} failed` : ", none failed"}
              </p>
            </>
          )}
        </div>
      );
    }

    case "map":
      return (
        <div className="panel">
          <Head title={title ?? "Map"} onMore={() => onGo("projects")} />
          <ProjectMap
            projects={data.projects.filter((p) => p.status === "active")}
            nodes={data.map}
            modules={data.modules.modules}
            onModules={() => onGo("settings", "modules")}
          />
        </div>
      );

    case "activity": {
      const rows = data.activity.slice(0, limit);
      return (
        <div className="panel">
          <Head title={title ?? "Activity"} onMore={() => onGo("history")} />
          {rows.length === 0 ? (
            <Empty>KOS has not done anything yet.</Empty>
          ) : (
            <ul className="panel-list">
              {rows.map((t) => (
                <li key={t.id}>
                  <span className={`panel-row ${t.isError ? "is-error" : ""}`}>
                    <span className="panel-row-main">
                      {summarizeAction(t.tool, t.args)}
                    </span>
                    <span className="panel-row-side">{ago(t.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    case "projects": {
      const rows = data.projects.filter((p) => p.status === "active");
      return (
        <div className="panel">
          <Head
            title={title ?? "Projects"}
            count={rows.length}
            onMore={() => onGo("projects")}
          />
          {rows.length === 0 ? (
            <Empty>No active projects. Ask KOS to build something.</Empty>
          ) : (
            <div className="panel-chips">
              {rows.slice(0, limit).map((p) => (
                <a
                  key={p.slug}
                  className="panel-chip"
                  href={hrefFor({ name: "project", slug: p.slug })}
                >
                  {p.name}
                </a>
              ))}
            </div>
          )}
        </div>
      );
    }

    case "chats": {
      const rows = data.chats.slice(0, limit);
      return (
        <div className="panel">
          <Head title={title ?? "Chats"} onMore={() => onGo("chats")} />
          {rows.length === 0 ? (
            <Empty>No conversations yet.</Empty>
          ) : (
            <ul className="panel-list">
              {rows.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="panel-row"
                    onClick={() => onOpenChat(c.id)}
                  >
                    <span className="panel-row-main">{c.title}</span>
                    <span className="panel-row-side">
                      {c.activity && c.activity !== "idle"
                        ? c.activity === "working"
                          ? "working"
                          : "needs you"
                        : ago(c.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    case "schedule": {
      const rows = data.crons.filter((c) => c.enabled).slice(0, limit);
      // Soonest first, so the side of each row is its next run.
      const next = new Map<number, number>();
      for (const r of data.upcoming) if (!next.has(r.id)) next.set(r.id, r.at);
      return (
        <div className="panel">
          <Head title={title ?? "Schedule"} onMore={() => onGo("crons")} />
          {rows.length === 0 ? (
            <Empty>Nothing runs on its own yet.</Empty>
          ) : (
            <>
              <DayLine runs={data.upcoming} />
              <ul className="panel-list">
                {rows.map((c) => (
                  <li key={c.id}>
                    <span className="panel-row">
                      <span className="panel-row-main">{c.name}</span>
                      {next.has(c.id) ? (
                        <span className="panel-row-side">{clockLabel(next.get(c.id)!)}</span>
                      ) : (
                        <code className="panel-row-side">{c.schedule}</code>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      );
    }

    case "spend": {
      const models = data.spend.models;
      const input = models.reduce((n, m) => n + m.inputTokens, 0);
      const output = models.reduce((n, m) => n + m.outputTokens, 0);
      const cost = models.reduce((n, m) => n + (m.cost ?? 0), 0);
      const priced = models.some((m) => m.cost !== undefined);
      const days = padDays(data.spend.byDay, 7);
      return (
        <div className="panel">
          <Head title={title ?? "Spend, last 7 days"} onMore={() => onGo("settings")} />
          {models.length === 0 ? (
            <Empty>Nothing spent this week.</Empty>
          ) : (
            <>
              <div className="panel-stats">
                <div>
                  <span className="panel-stat">{fmt(input)}</span>
                  <span className="panel-stat-label">in</span>
                </div>
                <div>
                  <span className="panel-stat">{fmt(output)}</span>
                  <span className="panel-stat-label">out</span>
                </div>
                {priced && (
                  <div>
                    <span className="panel-stat">${cost.toFixed(2)}</span>
                    <span className="panel-stat-label">at your rates</span>
                  </div>
                )}
              </div>
              {/* One bar per day of everything sent and received. Input is
                  a hundred times output, so stacking the two drew one. */}
              <Bars
                height={44}
                bars={days.map((d) => ({
                  label: dayLabel(d.day),
                  title: `${d.day}: ${fmt(d.inputTokens)} in, ${fmt(d.outputTokens)} out`,
                  parts: [{ value: d.inputTokens + d.outputTokens, tone: "accent" }],
                }))}
              />
              <Share parts={modelShares(models)} />
            </>
          )}
        </div>
      );
    }

    case "memory": {
      const mem = data.memory;
      const jobLabel: Record<string, string> = { "kos.memory": "Read", "kos.dream": "Tidy", "kos.observe": "Condense" };
      const on = mem.jobs.filter((j) => j.enabled);
      const latest = mem.jobs.reduce<number | null>((t, j) => (j.lastRunAt && (!t || j.lastRunAt > t) ? j.lastRunAt : t), null);
      return (
        <div className={`panel${mem.decisions > 0 ? " panel--attention" : ""}`}>
          <Head title={title ?? "Memory"} count={mem.decisions} onMore={() => onGo("memory")} />
          <div className="panel-stats">
            <div>
              <span className="panel-stat">{mem.claims}</span>
              <span className="panel-stat-label">claims</span>
            </div>
            <div>
              <span className="panel-stat">{mem.unread}</span>
              <span className="panel-stat-label">unread</span>
            </div>
            <div>
              <span className="panel-stat">{mem.decisions}</span>
              <span className="panel-stat-label">to decide</span>
            </div>
          </div>
          <p className="panel-note panel-memory-jobs">
            {mem.jobs.length === 0
              ? "No memory jobs yet."
              : on.length === 0
                ? `Jobs off${mem.extraction ? "; reading after each turn" : "; nothing reads the log"}.`
                : `${on.map((j) => jobLabel[j.name] ?? j.name).join(", ")} on${latest ? `, last ran ${ago(latest)} ago` : ", never ran"}.`}
          </p>
        </div>
      );
    }

    case "modules": {
      const mods = data.modules.modules;
      const builtinsOn = data.modules.builtins.filter((b) => b.enabled);
      const broken = mods.filter((m) => m.enabled && m.error);
      return (
        <div className={`panel${broken.length ? " panel--bad" : ""}`}>
          <Head title={title ?? "Modules"} count={broken.length} onMore={() => onGo("settings", "modules")} />
          {mods.length === 0 ? (
            <Empty>{`No workspace modules. Built in: ${builtinsOn.map((b) => b.name).join(", ") || "none"}.`}</Empty>
          ) : (
            <ul className="panel-list">
              {mods.slice(0, limit).map((mod) => (
                <li key={mod.name}>
                  <span className={`panel-row${mod.enabled && mod.error ? " is-error" : ""}`}>
                    <span className={`agent-dot agent-dot--${mod.blueprint ? "waiting" : !mod.enabled ? "stopped" : mod.error ? "failed" : mod.connected ? "running" : "waiting"}`} />
                    <span className="panel-row-main">{mod.name}</span>
                    <span className="panel-row-side">
                      {mod.blueprint
                        ? `blueprint · ${mod.blueprint.instances.length} ${mod.blueprint.instances.length === 1 ? "instance" : "instances"}`
                        : !mod.enabled
                          ? "off"
                          : mod.error
                            ? "not connected"
                            : mod.tools
                              ? `${mod.tools.length} tools`
                              : "starting"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    case "note":
      return (
        <div className="panel">
          <Head title={title ?? "Note"} />
          {editing ? (
            <textarea
              className="kos-input panel-note-edit"
              rows={4}
              value={panel.text ?? ""}
              placeholder="Anything you want on your home page."
              onChange={(e) => onChange({ text: e.target.value })}
            />
          ) : panel.text ? (
            <p className="panel-note">{panel.text}</p>
          ) : (
            <Empty>Empty note. Press Arrange to write in it.</Empty>
          )}
        </div>
      );

    default:
      return (
        <div className="panel">
          <Empty>Unknown panel.</Empty>
        </div>
      );
  }
}
