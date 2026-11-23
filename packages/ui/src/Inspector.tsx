import { useEffect, useState } from "react";
import { m } from "motion/react";
import { errorWords, formatDuration, hexOfHsl, hueOfHex, isState, kindWord, momentWords, slugWords, STATE_WORDS, stateOfRun, stepLine, summarizeAction } from "@kos/shared";
import { Card, ease, Field, lookOf, SheetFoot, StatusPill, Tag, When } from "@kos/kit";

import type {
  AuditRecord,
  CronJob,
  PageSummary,
  Project,
  RunRecord,
} from "./api.js";
import { api, type ProjectDetail } from "./api.js";
import { ColourChoice } from "./ColourPicker.js";
import { Drawer } from "./Drawer.js";
import { FileIcon } from "./FileIcon.js";
import { ConfirmButton } from "./kit.js";
import { markInk } from "./ProjectMark.js";
import { hrefFor } from "./routes.js";
import { Select } from "./Select.js";
import { runKind } from "./HistoryPage.js";
import { runChat } from "./runchat.js";
import { scheduleWords } from "./schedule.js";
import { jobTitle } from "./schedulewords.js";

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

/**
 * Where a step was made, by the chat it ran in. A schedule's step runs under
 * the owner's id, so "asked by you" was wrong for every one of them.
 */
export function madeIn(conversationId: string | null | undefined): string {
  if (!conversationId) return "—";
  if (conversationId.startsWith("cron:")) return "A schedule's run";
  if (conversationId.startsWith("agent:")) return `${slugWords(conversationId.slice(6))}, a blob`;
  return "A chat";
}

/** A run's raw error, only when it says more than the sentence over it. */
function rawSaysMore(raw: string, said: string): boolean {
  return raw.trim().replace(/\.$/, "").toLowerCase() !== said.replace(/\.$/, "").toLowerCase();
}

export function Inspector(props: {
  target: InspectTarget | null;
  onClose: () => void;
  onOpenPage?: (id: string) => void;
  /** Show a project's folder in the file browser. */
  onOpenFolder?: (path: string) => void;
  /** Open the project's own chat, its orchestrator, making it if need be. */
  onOpenProjectChat?: (slug: string) => void;
  /** Put KOS on this failure, in its own chat. */
  onFix?: (detail: {
    label: string;
    error: string;
    what: string;
    ref?: string;
  }) => void;
  /** So a run can name the job it belongs to rather than its id. */
  crons?: CronJob[];
  /** The chats there are, so a run offers the one it was written into while it is there. */
  chats?: ReadonlySet<string>;
  /** Open the chat a run was written into: a schedule's thread, or a turn's own chat. */
  onOpenChat?: (conversationId: string) => void;
  /** The workspace's folder, so a missing file is named from the workspace down. */
  workspace?: string;
  onSaved?: () => void;
  onSetProjectStatus?: (slug: string, status: string) => Promise<void>;
  /** Gone for good, after a second press. */
  onDeleteProject?: (slug: string) => Promise<void>;
  /** The name, what it is for and the kind, changed from the drawer. */
  onUpdateProject?: (slug: string, patch: { name?: string; description?: string | null; type?: string }) => Promise<void>;
  onSetProjectColour?: (slug: string, colour: string | null) => Promise<void>;
}): React.ReactElement | null {
  const { target, onClose } = props;
  /** The project as edited here, shown at once; the list behind catches up on its next read. */
  const [local, setLocal] = useState<{ name: string; description: string | null; type: string; colour: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", description: "", type: "" });
  const [busy, setBusy] = useState(false);
  // Counts, tables, sites and schema history, fetched when a project is
  // opened rather than carried on the card: the list does not need them and
  // this is the one place they are read.
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [call, setCall] = useState<AuditRecord | null>(null);
  const [editStatus, setEditStatus] = useState<string | null>(null);
  /** The delete button has been pressed once; the next press is the deed. */
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

  if (!target) return <Drawer open={false} title="" onClose={onClose}>{null}</Drawer>;

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
      const line = stepLine(t.tool, t.args);
      title = line.title;
      subtitle = `Step · ${t.isError ? "Failed" : "Done"}`;
      // What happened, in words, then when; the tool, its arguments and the
      // raw result are the machinery, there for the curious under Details.
      body = (
        <>
          <p className={`insp-lead${t.isError ? " insp-lead--bad" : ""}`}>{t.isError ? errorWords(t.result, { root: props.workspace }) : (line.detail ?? summarizeAction(t.tool, t.args))}</p>
          {!t.isError && <Block label="What it returned" text={t.result || (call ? "Nothing" : "…")} />}
          <Facts rows={[["When", momentWords(t.createdAt)]]} />
          <Details>
            <Facts
              rows={[
                ["Tool", t.tool],
                ["Checked as", t.riskTier ?? "—"],
                ["Made in", madeIn(t.conversationId)],
              ]}
            />
            {t.isError && <Block label="What it said" text={t.result || "—"} />}
            <Block label="What it was given" text={prettyJson(t.args)} />
          </Details>
        </>
      );
      actions =
        t.isError && props.onFix ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            title="Opens a chat where KOS looks into this and tries to fix it"
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
            Fix in a chat
          </button>
        ) : null;
      break;
    }
    case "run": {
      const r = target.data;
      const job = props.crons?.find((c) => String(c.id) === r.ref);
      title = job ? jobTitle(job.name) : `${runKind(r.kind)} run`;
      subtitle = `${runKind(r.kind)} · ${STATE_WORDS[stateOfRun(r.status)].word}`;
      // The error first, because on a failed run it is the only reason the
      // drawer was opened. It used to be last, under four rows of timing.
      body = (
        <>
          {r.error && <p className="insp-lead insp-lead--bad">{errorWords(r.error)}</p>}
          <div className="insp-cols">
            <div className="insp-main">
              {r.error ? (
                rawSaysMore(r.error, errorWords(r.error)) && (
                  <Details>
                    <pre className="insp-pre">{r.error}</pre>
                  </Details>
                )
              ) : (
                <p className="ops-muted">This run finished without an error.</p>
              )}
              {job && (
                <Section title="The schedule">
                  <ul className="insp-rows">
                    <li>
                      <span>{scheduleWords(job.schedule)}</span>
                      <span className="insp-meta">{job.type === "self_prompt" ? "Asks KOS" : "Runs its steps"}</span>
                      <StatusPill state={job.enabled ? "on" : "off"} />
                    </li>
                    {(job.actions ?? []).map((a, i) => {
                      const step = stepLine(a.tool, a.args);
                      return (
                        <li key={i}>
                          <span>{step.title}</span>
                          {step.detail && <span className="insp-meta">{step.detail}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}
            </div>
            <aside className="insp-side">
              <Section title="Run">
                <dl className="insp-about">
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <StatusPill state={stateOfRun(r.status)} />
                    </dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{r.startedAt ? <When at={r.startedAt} /> : "—"}</dd>
                  </div>
                  <div>
                    <dt>Took</dt>
                    <dd>{r.durationMs != null ? formatDuration(r.durationMs) : "—"}</dd>
                  </div>
                </dl>
              </Section>
            </aside>
          </div>
        </>
      );
      const chat = props.onOpenChat ? runChat(r, props.crons ?? [], props.chats ?? new Set()) : undefined;
      const fix =
        stateOfRun(r.status) === "failed" && props.onFix ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            title="Opens a chat where KOS looks into this and tries to fix it"
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
            Fix in a chat
          </button>
        ) : null;
      // What the run said, step by step, is in the chat it was written into.
      actions =
        chat || fix ? (
          <>
            {chat && (
              <button type="button" className="btn" onClick={() => props.onOpenChat?.(chat)}>
                Open its chat
              </button>
            )}
            {fix}
          </>
        ) : null;
      break;
    }
    case "project": {
      const p = { ...target.data, ...(local ?? {}) };
      title = p.name;
      // The live value, not the one the card was holding when it was clicked:
      // the header went on saying "active" after the status had been changed
      // to dormant a few pixels below it.
      const status = editStatus ?? p.status;
      subtitle = `${kindWord(p.type)} · ${isState(status) ? STATE_WORDS[status].word : kindWord(status)}`;
      const hue = (p.colour ? hueOfHex(p.colour) : null) ?? lookOf(p.slug).hue;
      const saveEdit = (): void => {
        if (!props.onUpdateProject || !draft.name.trim()) return;
        void run(async () => {
          await props.onUpdateProject!(p.slug, { name: draft.name, description: draft.description, type: draft.type });
          setLocal({ name: draft.name.trim(), description: draft.description.trim() || null, type: draft.type.trim() || p.type, colour: p.colour ?? null });
          setEditing(false);
        });
      };
      const recolour = (colour: string | null): void => {
        if (!props.onSetProjectColour) return;
        void run(async () => {
          await props.onSetProjectColour!(p.slug, colour);
          setLocal({ name: p.name, description: p.description ?? null, type: p.type, colour });
        });
      };
      const hero = (
        <div className="insp-hero-row" style={{ "--blob-h": String(hue) } as React.CSSProperties}>
          <div className="insp-hero">
            <span className="hero-mark hero-mark--sm" aria-hidden="true" style={p.colour ? { background: p.colour, color: markInk(p.colour) } : undefined}>
              <FileIcon name={p.slug} kind="dir" size={22} />
            </span>
            {editing ? (
              <form
                className="insp-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveEdit();
                }}
              >
                <Field label="Name" required>
                  <input className="kos-input" value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
                <Field label="What it is for">
                  <input className="kos-input" value={draft.description} placeholder="One line, as the card shows it" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </Field>
                <Field label="Kind" hint="project, tracker, notes, budget, app, research, or a word of your own">
                  <input className="kos-input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} />
                </Field>
                <Field label="Colour" group>
                  <ColourChoice
                    value={p.colour ?? hexOfHsl(hue, 70, 60)}
                    swatchHue={p.colour ? undefined : hue}
                    picked={Boolean(p.colour)}
                    fillOfHue={(h) => `hsl(${h} 70% 60%)`}
                    onSwatch={(h) => recolour(hexOfHsl(h, 70, 60))}
                    onPick={(hex) => recolour(hex)}
                  />
                </Field>
                <div className="insp-edit-acts">
                  <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !draft.name.trim()}>
                    Save
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  {p.colour && (
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => recolour(null)} title="Let the name decide the colour again">
                      Colour from the name
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <div className="insp-hero-words">
                {p.description && <p className="insp-desc">{p.description}</p>}
                <div className="hero-meta insp-hero-meta">
                  {isState(status) && <StatusPill state={status} />}
                  <Tag>{kindWord(p.type)}</Tag>
                </div>
              </div>
            )}
          </div>
          <div className="insp-head-acts">
            {!editing && props.onUpdateProject && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setDraft({ name: p.name, description: p.description ?? "", type: p.type });
                  setEditing(true);
                }}
              >
                Edit
              </button>
            )}
          </div>
        </div>
      );
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
          {hero}
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

              {(detail?.skills?.length ?? 0) > 0 && (
                <Section title="Skills">
                  <ul className="insp-rows">
                    {detail!.skills!.map((sk) => (
                      <li key={sk.name}>
                        {/* The name opens the file itself in Files: a skill is a file first. */}
                        <a className="ops-link" href={hrefFor({ name: "files", path: sk.file })} title={sk.description}>
                          {sk.name}
                        </a>
                        <span className="insp-meta">
                          {sk.kind}
                          {sk.kind === "script" ? (sk.promoted ? " · promoted" : " · not promoted") : ""}
                          {sk.enabled ? "" : " · off"}
                        </span>
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
                        <span>{jobTitle(c.name)}</span>
                        <span className="insp-meta">{scheduleWords(c.schedule)}</span>
                        <StatusPill state={c.enabled ? "on" : "off"} />
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
                          <span>{stepLine(a.tool, a.args).title}</span>
                          {stepLine(a.tool, a.args).detail && <span className="insp-meta">{stepLine(a.tool, a.args).detail}</span>}
                        </span>
                        <span className="insp-meta">
                          {a.isError ? "Failed · " : ""}
                          <When at={a.createdAt} />
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
                  options={STATUSES.map((s) => ({ value: s, label: STATE_WORDS[s].word }))}
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
                    <dd>{kindWord(p.type)}</dd>
                  </div>
                  <div>
                    <dt>Module</dt>
                    <dd className="ops-mono">{p.module ?? "embedded"}</dd>
                  </div>
                  <div>
                    <dt>Orchestrator</dt>
                    <dd>
                      <button
                        type="button"
                        className="ops-link"
                        onClick={() => props.onOpenProjectChat?.(p.slug)}
                      >
                        Open this project's orchestrator
                      </button>
                    </dd>
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
                    <dd>{p.createdAt ? <When at={p.createdAt} /> : "—"}</dd>
                  </div>
                  {/* Within a minute of creation these say the same thing
                      twice, which is two rows to read and nothing learned. */}
                  {Math.abs((p.lastTouchedAt ?? 0) - (p.createdAt ?? 0)) >
                    60_000 && (
                    <div>
                      <dt>Last touched</dt>
                      <dd>{p.lastTouchedAt ? <When at={p.lastTouchedAt} /> : "—"}</dd>
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

              {props.onDeleteProject && (
                <Section title="Delete">
                  {/* Asked once, beside the button: the one thing in this
                      drawer that cannot be undone. Archiving, above, is the
                      reversible way to set a project aside. */}
                  <p className="insp-meta">Gone for good. To set it aside instead, set its status to archived.</p>
                  <ConfirmButton
                    label="Delete project"
                    confirmLabel="Delete for good"
                    className="btn btn--sm btn--danger"
                    text={`Delete ${p.name}? Its chats, and what of it is in the trash, are kept; the rest goes.`}
                    disabled={busy}
                    onConfirm={() => void run(() => props.onDeleteProject!(p.slug))}
                  />
                </Section>
              )}
            </aside>
          </m.div>
        </>
      );
      break;
    }
  }

  // The one drawer every sheet is (`Drawer`): its head, its focus, Escape, and the foot when there is something to press.
  return (
    <Drawer
      open
      wide
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      {...(actions ? { footer: <SheetFoot {...(busy ? { note: "Saving…" } : {})} primary={actions} /> } : {})}
    >
      <div className="insp-body">
        {err && <div className="ops-alert ops-alert--err">{err}</div>}
        {body}
      </div>
    </Drawer>
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
function Section(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Card title={props.title} className="insp-section">
      {props.children}
    </Card>
  );
}

/** The machinery behind what the drawer says: folded, for the curious. */
function Details({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <details className="settings-more insp-details">
      <summary>Details</summary>
      {children}
    </details>
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
