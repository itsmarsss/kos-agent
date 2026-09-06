import { useEffect, useState } from "react";
import { m } from "motion/react";
import { summarizeAction } from "@kos/shared";

import type {
  AuditRecord,
  CronJob,
  PageSummary,
  Project,
  RunRecord,
} from "./api.js";
import { api, type ProjectDetail } from "./api.js";
import { ease, spring } from "./motion.js";
import { Select } from "./Select.js";

export type InspectTarget =
  | { kind: "tool"; data: AuditRecord }
  | { kind: "run"; data: RunRecord }
  | { kind: "project"; data: Project; pages: PageSummary[] };

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * How long ago, in the same words the rest of the app uses. The drawer said
 * "9/1/2026, 7:43:16 AM" twice, to the second, next to a card reading "20h
 * ago"; the exact time is kept on hover for when it matters.
 */
function ago(ts?: number | null): string {
  if (ts == null) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return fmtTime(ts);
}

function fmtTime(ts?: number | null): string {
  if (ts == null) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

const STATUSES = ["born", "active", "dormant", "done", "archived"] as const;

/** Total rows across a project's tables, the one number worth leading with. */
function rowTotal(detail: ProjectDetail | null): string {
  if (!detail) return "—";
  const known = detail.tables.filter((t) => t.rows >= 0);
  if (known.length === 0) return "0";
  return known.reduce((n, t) => n + t.rows, 0).toLocaleString();
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="insp-stat">
      <span className="insp-stat-value">{value}</span>
      <span className="insp-stat-label">{label}</span>
    </div>
  );
}

export function Inspector(props: {
  target: InspectTarget | null;
  onClose: () => void;
  onOpenPage?: (id: string) => void;
  /** Show a project's folder in the file browser. */
  onOpenFolder?: (path: string) => void;
  /** Put KOS on this failure, in its own chat. */
  onFix?: (detail: {
    label: string;
    error: string;
    what: string;
    ref?: string;
  }) => void;
  /** So a run can name the job it belongs to rather than its id. */
  crons?: CronJob[];
  onSaved?: () => void;
  onSetProjectStatus?: (slug: string, status: string) => Promise<void>;
}): React.ReactElement | null {
  const { target, onClose } = props;
  const [busy, setBusy] = useState(false);
  // Counts, tables, sites and schema history, fetched when a project is
  // opened rather than carried on the card: the list does not need them and
  // this is the one place they are read.
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [call, setCall] = useState<AuditRecord | null>(null);
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const openSlug = target?.kind === "project" ? target.data.slug : null;
  useEffect(() => {
    if (!openSlug) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api
      .projectDetail(openSlug)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        // The drawer still shows what the card already knew; the extra
        // detail simply does not appear.
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openSlug]);

  /*
   * The full call, fetched because the list no longer carries it.
   *
   * A tool result is the bulk of the activity response and the list never
   * shows one, so it is left out there and read here, where it is the thing
   * the drawer was opened for.
   */
  const openCallId = target?.kind === "tool" ? target.data.id : null;
  useEffect(() => {
    if (openCallId === null) {
      setCall(null);
      return;
    }
    let cancelled = false;
    void api
      .call(openCallId)
      .then((c) => {
        if (!cancelled) setCall(c);
      })
      .catch(() => {
        // The row the list already had is still on screen; only the result
        // stays as it came.
        if (!cancelled) setCall(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openCallId]);


  if (!target) return null;

  const projectSlug = target.kind === "project" ? target.data.slug : "";

  let title = "";
  let subtitle = "";
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      props.onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  switch (target.kind) {
    case "tool": {
      const t = call && call.id === target.data.id ? call : target.data;
      title = t.tool;
      subtitle = `Tool call #${t.id} · ${t.isError ? "error" : "ok"}`;
      // What happened, then what it was asked, then who and when. The
      // metadata was above the result, so the thing you opened the drawer to
      // read was the last thing on it.
      body = (
        <>
          <p className="insp-lead">{summarizeAction(t.tool, t.args)}</p>
          <Block label="Result" text={t.result || (call ? "—" : "…")} />
          <Block label="Args" text={prettyJson(t.args)} />
          <Facts
            rows={[
              ["When", fmtTime(t.createdAt)],
              ["Risk", t.riskTier ?? "—"],
              ["User", t.userId ?? "—"],
            ]}
          />
        </>
      );
      actions =
        t.isError && props.onFix ? (
          <button
            type="button"
            className="ops-btn ops-btn--primary"
            disabled={busy}
            onClick={() => {
              props.onFix?.({
                label: t.tool,
                error: t.result || "the tool reported an error",
                what: "tool call",
                ref: `tool call #${t.id}`,
              });
              onClose();
            }}
          >
            Fix this
          </button>
        ) : null;
      break;
    }
    case "run": {
      const r = target.data;
      const job = props.crons?.find((c) => String(c.id) === r.ref);
      title = job?.name ?? `${r.kind} run`;
      subtitle = `${r.kind} #${r.id} · ${r.status}`;
      // The error first, because on a failed run it is the only reason the
      // drawer was opened. It used to be last, under four rows of timing.
      body = (
        <>
          {r.error && <p className="insp-lead insp-lead--bad">{r.error}</p>}
          <div className="insp-cols">
            <div className="insp-main">
              {r.error ? (
                <Section title="What it said">
                  <pre className="insp-pre">{r.error}</pre>
                </Section>
              ) : (
                <p className="ops-muted">This run finished without an error.</p>
              )}
              {job && (
                <Section title="The job">
                  <ul className="insp-rows">
                    <li>
                      <span className="ops-mono">{job.schedule}</span>
                      <span className="insp-meta">{job.type}</span>
                      <span
                        className={`ops-tag ${
                          job.enabled ? "ops-tag--ok" : "ops-tag--muted"
                        }`}
                      >
                        {job.enabled ? "on" : "off"}
                      </span>
                    </li>
                    {(job.actions ?? []).map((a, i) => (
                      <li key={i}>
                        <span className="ops-mono">{a.tool}</span>
                        <span className="insp-meta">{JSON.stringify(a.args)}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>
            <aside className="insp-side">
              <Section title="Run">
                <dl className="insp-about">
                  <div>
                    <dt>Status</dt>
                    <dd>{r.status}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd title={fmtTime(r.startedAt)}>{ago(r.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>Took</dt>
                    <dd>{r.durationMs != null ? `${r.durationMs} ms` : "—"}</dd>
                  </div>
                  {r.ref && (
                    <div>
                      <dt>Ref</dt>
                      <dd className="ops-mono">{r.ref}</dd>
                    </div>
                  )}
                </dl>
              </Section>
            </aside>
          </div>
        </>
      );
      actions =
        r.status === "error" && props.onFix ? (
          <button
            type="button"
            className="ops-btn ops-btn--primary"
            disabled={busy}
            onClick={() => {
              props.onFix?.({
                label: job?.name ?? `${r.kind} run`,
                error: r.error ?? "the run reported an error",
                what: r.kind === "cron" ? "scheduled job" : "run",
                ...(r.ref ? { ref: `${r.kind} #${r.ref}` } : {}),
              });
              onClose();
            }}
          >
            Fix this
          </button>
        ) : null;
      break;
    }
    case "project": {
      const p = target.data;
      title = p.name;
      // The live value, not the one the card was holding when it was clicked:
      // the header went on saying "active" after the status had been changed
      // to dormant a few pixels below it.
      const status = editStatus ?? p.status;
      subtitle = `${p.slug} · ${status}`;
      const pages = detail?.pages ?? target.pages;
      const sites = detail?.sites ?? [];
      const schedules = detail?.crons ?? [];
      const tables = detail?.tables ?? [];
      const empty =
        detail !== null &&
        tables.length === 0 &&
        pages.length === 0 &&
        sites.length === 0 &&
        schedules.length === 0;

      // Contents on the left, controls and metadata on the right. It was one
      // column down the middle of a 720px panel, so every row stretched its
      // value to the far edge and the eye had to travel the width of the
      // drawer to read "5 rows".
      body = (
        <>
          {p.description && <p className="insp-desc">{p.description}</p>}

          {/* The counts arrive after the panel does, and snapping from a row
              of dashes to a row of numbers reads as the drawer flinching.
              Keyed on whether they are known, so they cross-fade instead. */}
          <m.div
            className="insp-stats"
            key={detail ? "counted" : "counting"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={ease}
          >
            <Stat label="Rows" value={rowTotal(detail)} />
            <Stat label="Tables" value={detail ? String(tables.length) : "—"} />
            <Stat label="Pages" value={String(pages.length)} />
            <Stat label="Sites" value={detail ? String(sites.length) : "—"} />
            <Stat
              label="Schedules"
              value={detail ? String(schedules.length) : "—"}
            />
          </m.div>

          <m.div
            className="insp-cols"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={ease}
          >
            <div className="insp-main">
              {empty && (
                <p className="ops-muted">
                  Nothing in it yet. Ask KOS to add a table or a page.
                </p>
              )}

              {tables.length > 0 && (
                <Section title="Data">
                  <ul className="insp-rows">
                    {tables.map((t) => (
                      <li key={t.name}>
                        <span className="ops-mono">{t.name}</span>
                        <span className="insp-meta">
                          {t.rows < 0
                            ? "unreadable"
                            : `${t.rows.toLocaleString()} ${
                                t.rows === 1 ? "row" : "rows"
                              }`}
                          {" · "}
                          {t.columns} cols
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {pages.length > 0 && (
                <Section title="Pages">
                  <ul className="insp-rows">
                    {pages.map((pg) => (
                      <li key={pg.id}>
                        <button
                          type="button"
                          className="ops-link"
                          onClick={() => props.onOpenPage?.(pg.id)}
                        >
                          {pg.title}
                        </button>
                        <span className="insp-meta ops-mono">{pg.id}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {sites.length > 0 && (
                <Section title="Sites">
                  <ul className="insp-rows">
                    {sites.map((site) => (
                      <li key={site.path}>
                        {detail?.sitesBase && site.hasIndex ? (
                          <a
                            className="ops-link"
                            href={`${detail.sitesBase}/${site.project}/${site.name}/`}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {site.name}
                          </a>
                        ) : (
                          <span>{site.name}</span>
                        )}
                        <span className="insp-meta">
                          {site.hasIndex ? "live" : "no index.html"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {schedules.length > 0 && (
                <Section title="Schedules">
                  <ul className="insp-rows">
                    {schedules.map((c) => (
                      <li key={c.id}>
                        <span>{c.name}</span>
                        <span className="insp-meta ops-mono">{c.schedule}</span>
                        <span
                          className={`ops-tag ${
                            c.enabled ? "ops-tag--ok" : "ops-tag--muted"
                          }`}
                        >
                          {c.enabled ? "on" : "off"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {detail && detail.activity.length > 0 && (
                <Section title="Recent">
                  <ul className="insp-rows insp-rows--stacked">
                    {detail.activity.map((a) => (
                      <li key={a.id}>
                        <span className="insp-act">
                          <span className="ops-mono">{a.tool}</span>
                          <span className="insp-meta">
                            {summarizeAction(a.tool, a.args)}
                          </span>
                        </span>
                        <span className="insp-meta" title={fmtTime(a.createdAt)}>
                          {a.isError ? "failed · " : ""}
                          {ago(a.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </div>

            <aside className="insp-side">
              <Section title="Status">
                {/* Saved on change. The select was at the top of the drawer
                    and its Save button at the very bottom, so the control and
                    the thing that committed it were never on screen together. */}
                <Select
                  className="insp-select"
                  label="Status"
                  value={status}
                  options={STATUSES.map((s) => ({ value: s, label: s }))}
                  onChange={(v: string) => {
                    setEditStatus(v);
                    if (props.onSetProjectStatus) {
                      void run(() => props.onSetProjectStatus!(p.slug, v));
                    }
                  }}
                />
                {busy && <span className="insp-meta">Saving…</span>}
                {!busy && editStatus !== null && editStatus === p.status && (
                  <span className="insp-meta">Saved</span>
                )}
              </Section>

              <Section title="About">
                <dl className="insp-about">
                  <div>
                    <dt>Type</dt>
                    <dd>{p.type}</dd>
                  </div>
                  <div>
                    <dt>Module</dt>
                    <dd className="ops-mono">{p.module ?? "embedded"}</dd>
                  </div>
                  <div>
                    <dt>Folder</dt>
                    <dd>
                      {detail?.folder ? (
                        <button
                          type="button"
                          className="ops-link ops-mono"
                          onClick={() => props.onOpenFolder?.(detail.folder)}
                        >
                          {detail.folder}
                        </button>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd title={fmtTime(p.createdAt)}>{ago(p.createdAt)}</dd>
                  </div>
                  {/* Within a minute of creation these say the same thing
                      twice, which is two rows to read and nothing learned. */}
                  {Math.abs((p.lastTouchedAt ?? 0) - (p.createdAt ?? 0)) >
                    60_000 && (
                    <div>
                      <dt>Last touched</dt>
                      <dd title={fmtTime(p.lastTouchedAt)}>
                        {ago(p.lastTouchedAt)}
                      </dd>
                    </div>
                  )}
                </dl>
              </Section>

              {detail && detail.migrations.length > 0 && (
                <Section title="Schema">
                  <ul className="insp-rows">
                    {detail.migrations.map((mig) => (
                      <li key={mig.id}>
                        <span className="ops-mono">v{mig.version}</span>
                        <span className="insp-meta">{mig.op}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </aside>
          </m.div>
        </>
      );
      void projectSlug;
      break;
    }
  }

  return (
    /*
     * Entering and leaving.
     *
     * The panel had a CSS keyframe on the way in and nothing on the way out,
     * so it slid open and then vanished. A drawer that disappears rather than
     * closing leaves you unsure whether you dismissed it or it failed.
     */
    <m.div
      className="insp-backdrop"
      role="presentation"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={ease}
    >
      <m.aside
        className="insp-panel"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        initial={{ x: 28, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 28, opacity: 0 }}
        transition={spring}
      >
        <header className="insp-head">
          <div>
            <div className="insp-kicker">{target.kind}</div>
            <h2 className="insp-title">{title}</h2>
            <div className="ops-muted">{subtitle}</div>
          </div>
          <button type="button" className="ops-btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="insp-body">
          {err && <div className="ops-alert ops-alert--err">{err}</div>}
          {body}
        </div>
        {/* Only when there is something to press. A project saves its status
            from the control itself now, so a footer here would be an empty
            bar that says "saving..." somewhere the eye is not. */}
        {actions && (
          <footer className="insp-foot">
            {busy && <span className="ops-busy">saving…</span>}
            {actions}
          </footer>
        )}
      </m.aside>
    </m.div>
  );
}

/** Metadata as pairs: compact, and clearly not the point of the page. */
function Facts({ rows }: { rows: [string, string][] }): React.ReactElement {
  return (
    <dl className="insp-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A labelled group. One heading style everywhere, rather than nine. */
function Section(props: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="insp-section">
      <h3 className="insp-label">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Block(props: { label: string; text: string }): React.ReactElement {
  return (
    <div className="insp-field">
      <div className="insp-label">{props.label}</div>
      <pre className="insp-pre">{props.text}</pre>
    </div>
  );
}
