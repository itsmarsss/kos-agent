import { useState } from "react";
import { summarizeAction } from "@kos/shared";

import type {
  AuditRecord,
  CronJob,
  FactRow,
  PageSummary,
  Project,
  RunRecord,
} from "./api.js";

export type InspectTarget =
  | { kind: "tool"; data: AuditRecord }
  | { kind: "cron"; data: CronJob }
  | { kind: "run"; data: RunRecord }
  | { kind: "fact"; data: FactRow }
  | { kind: "project"; data: Project; pages: PageSummary[] };

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
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

export function Inspector(props: {
  target: InspectTarget | null;
  onClose: () => void;
  onOpenPage?: (id: string) => void;
  onSaved?: () => void;
  onSetProjectStatus?: (slug: string, status: string) => Promise<void>;
  onToggleCron?: (id: number, enabled: boolean) => Promise<void>;
  onDeleteCron?: (id: number) => Promise<void>;
  onSaveFact?: (
    key: string,
    value: string,
    kind: "fact" | "preference",
  ) => Promise<void>;
  onDeleteFact?: (key: string) => Promise<void>;
}): React.ReactElement | null {
  const { target, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [editValue, setEditValue] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<"fact" | "preference">("fact");
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!target) return null;

  // Sync local edit buffers when target identity changes (lightweight).
  const factKey = target.kind === "fact" ? target.data.key : "";
  const projectSlug = target.kind === "project" ? target.data.slug : "";
  if (target.kind === "fact" && editValue === null) {
    // initialize once per open via state reset pattern below is awkward;
    // use key on parent to remount. Parent sets inspect with new object.
  }

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
      const t = target.data;
      title = t.tool;
      subtitle = `Tool call #${t.id} · ${t.isError ? "error" : "ok"}`;
      body = (
        <>
          <Field label="Summary" value={summarizeAction(t.tool, t.args)} />
          <Field label="When" value={fmtTime(t.createdAt)} />
          <Field label="Risk" value={t.riskTier ?? "—"} />
          <Field label="User" value={t.userId ?? "—"} />
          <Block label="Args" text={prettyJson(t.args)} />
          <Block label="Result" text={t.result || "—"} />
        </>
      );
      break;
    }
    case "cron": {
      const c = target.data;
      title = c.name;
      subtitle = `Cron #${c.id} · ${c.enabled ? "enabled" : "disabled"}`;
      body = (
        <>
          <Field label="Schedule" value={c.schedule} mono />
          <Field label="Type" value={c.type} />
          <Field label="Project" value={c.projectSlug ?? "—"} mono />
          <Field label="Query" value={c.query ?? "—"} />
          <Field label="Condition" value={c.condition?.test ?? "—"} mono />
          {c.type === "self_prompt" && (
            <Block label="Prompt" text={c.prompt ?? "—"} />
          )}
          {c.actions && c.actions.length > 0 && (
            <Block label="Actions" text={JSON.stringify(c.actions, null, 2)} />
          )}
          <Field label="Created" value={fmtTime(c.createdAt)} />
          <Field label="Updated" value={fmtTime(c.updatedAt)} />
        </>
      );
      actions = (
        <>
          {props.onToggleCron && (
            <button
              type="button"
              className="ops-btn"
              disabled={busy}
              onClick={() =>
                void run(() => props.onToggleCron!(c.id, !c.enabled))
              }
            >
              {c.enabled ? "Disable" : "Enable"}
            </button>
          )}
          {props.onDeleteCron && (
            <button
              type="button"
              className="ops-btn ops-btn--danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete cron “${c.name}”?`)) {
                  void run(async () => {
                    await props.onDeleteCron!(c.id);
                    onClose();
                  });
                }
              }}
            >
              Delete
            </button>
          )}
        </>
      );
      break;
    }
    case "run": {
      const r = target.data;
      title = `${r.kind} run`;
      subtitle = `#${r.id} · ${r.status}`;
      body = (
        <>
          <Field label="Ref" value={r.ref ?? "—"} mono />
          <Field label="Started" value={fmtTime(r.startedAt)} />
          <Field label="Finished" value={fmtTime(r.finishedAt)} />
          <Field
            label="Duration"
            value={r.durationMs != null ? `${r.durationMs} ms` : "—"}
          />
          <Block label="Error" text={r.error ?? "(none)"} />
        </>
      );
      break;
    }
    case "fact": {
      const f = target.data;
      title = f.key;
      subtitle = `Memory · ${f.kind}`;
      const value = editValue ?? f.value;
      const kind = editKind || (f.kind === "preference" ? "preference" : "fact");
      body = (
        <>
          <Field label="Key" value={f.key} mono />
          <div className="insp-field">
            <div className="insp-label">Kind</div>
            <Select
              className="insp-select"
              label="Kind"
              value={kind}
              options={[
                { value: "fact", label: "fact" },
                { value: "preference", label: "preference" },
              ]}
              onChange={(v) => setEditKind(v === "preference" ? "preference" : "fact")}
            />
          </div>
          <div className="insp-field">
            <div className="insp-label">Value</div>
            <textarea
              className="ops-textarea"
              rows={6}
              value={value}
              onChange={(e) => setEditValue(e.target.value)}
            />
          </div>
          <Field label="Source" value={f.source ?? "—"} />
          <Field label="Updated" value={fmtTime(f.updatedAt)} />
        </>
      );
      actions = (
        <>
          {props.onSaveFact && (
            <button
              type="button"
              className="ops-btn ops-btn--primary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  props.onSaveFact!(f.key, editValue ?? f.value, kind),
                )
              }
            >
              Save
            </button>
          )}
          {props.onDeleteFact && (
            <button
              type="button"
              className="ops-btn ops-btn--danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete memory “${f.key}”?`)) {
                  void run(async () => {
                    await props.onDeleteFact!(f.key);
                    onClose();
                  });
                }
              }}
            >
              Delete
            </button>
          )}
        </>
      );
      void factKey;
      break;
    }
    case "project": {
      const p = target.data;
      title = p.name;
      subtitle = `${p.slug} · ${p.status}`;
      const status = editStatus ?? p.status;
      body = (
        <>
          <Field label="Slug" value={p.slug} mono />
          <Field label="Type" value={p.type} />
          <div className="insp-field">
            <div className="insp-label">Status</div>
            <Select
              className="insp-select"
              label="Status"
              value={status}
              options={STATUSES.map((s) => ({ value: s, label: s }))}
              onChange={setEditStatus}
            />
          </div>
          <Field label="Module" value={p.module ?? "embedded"} mono />
          <Field label="Description" value={p.description ?? "—"} />
          <Field label="Created" value={fmtTime(p.createdAt)} />
          <Field label="Last touched" value={fmtTime(p.lastTouchedAt)} />
          <div className="insp-field">
            <div className="insp-label">Pages</div>
            {target.pages.length === 0 && (
              <div className="ops-muted">No pages linked</div>
            )}
            <ul className="insp-pages">
              {target.pages.map((pg) => (
                <li key={pg.id}>
                  <button
                    type="button"
                    className="ops-link"
                    onClick={() => props.onOpenPage?.(pg.id)}
                  >
                    {pg.title}
                  </button>
                  <span className="ops-mono ops-muted">{pg.id}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      );
      actions = props.onSetProjectStatus ? (
        <button
          type="button"
          className="ops-btn ops-btn--primary"
          disabled={busy || status === p.status}
          onClick={() =>
            void run(() => props.onSetProjectStatus!(p.slug, status))
          }
        >
          Save status
        </button>
      ) : null;
      void projectSlug;
      break;
    }
  }

  return (
    <div className="insp-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="insp-panel"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
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
        {(actions || busy) && (
          <footer className="insp-foot">
            {busy && <span className="ops-busy">saving…</span>}
            {actions}
          </footer>
        )}
      </aside>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="insp-field">
      <div className="insp-label">{props.label}</div>
      <div className={props.mono ? "ops-mono" : undefined}>{props.value}</div>
    </div>
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
