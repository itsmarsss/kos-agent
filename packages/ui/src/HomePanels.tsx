import type { ReactElement } from "react";
import type { HomePanel } from "@kos/shared";
import { summarizeAction } from "@kos/shared";

import type { FailingJob, HomeData } from "./api.js";
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

type Go = (to: "agents" | "history" | "projects" | "crons" | "chats" | "settings") => void;

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
  onDecide: (id: number, approved: boolean) => void;
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
      return (
        <div className="panel panel--attention">
          <Head title={title ?? "Needs you"} count={rows.length} />
          {rows.length === 0 ? (
            <Empty>Nothing is waiting on you.</Empty>
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
          {report.recent.total > 0 && (
            // Labelled, because the count in the header is jobs broken right
            // now and this is runs over time: "What broke 1" above "5 of the
            // last 100 failed" read as a contradiction.
            <p className="panel-foot">
              Failure rate: {report.recent.errors} of the last{" "}
              {report.recent.total} runs ({Math.round(rate * 100)}%)
            </p>
          )}
        </div>
      );
    }

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
                  href={hrefFor({ name: "projects" })}
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
      return (
        <div className="panel">
          <Head title={title ?? "Schedule"} onMore={() => onGo("crons")} />
          {rows.length === 0 ? (
            <Empty>Nothing runs on its own yet.</Empty>
          ) : (
            <ul className="panel-list">
              {rows.map((c) => (
                <li key={c.id}>
                  <span className="panel-row">
                    <span className="panel-row-main">{c.name}</span>
                    <code className="panel-row-side">{c.schedule}</code>
                  </span>
                </li>
              ))}
            </ul>
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
      const fmt = (n: number): string =>
        n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
      return (
        <div className="panel">
          <Head title={title ?? "Spend, last 7 days"} onMore={() => onGo("settings")} />
          {models.length === 0 ? (
            <Empty>Nothing spent this week.</Empty>
          ) : (
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
