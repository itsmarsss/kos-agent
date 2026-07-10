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

export function Inspector(props: {
  target: InspectTarget | null;
  onClose: () => void;
  onOpenPage?: (id: string) => void;
}): React.ReactElement | null {
  const { target, onClose, onOpenPage } = props;
  if (!target) return null;

  let title = "";
  let subtitle = "";
  let body: React.ReactNode = null;

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
          <Field
            label="Condition"
            value={c.condition?.test ?? "—"}
            mono
          />
          {c.type === "self_prompt" && (
            <Block label="Prompt" text={c.prompt ?? "—"} />
          )}
          {c.actions && c.actions.length > 0 && (
            <Block
              label="Actions"
              text={JSON.stringify(c.actions, null, 2)}
            />
          )}
          <Field label="Created" value={fmtTime(c.createdAt)} />
          <Field label="Updated" value={fmtTime(c.updatedAt)} />
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
            value={
              r.durationMs != null ? `${r.durationMs} ms` : "—"
            }
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
      body = (
        <>
          <Field label="Kind" value={f.kind} />
          <Field label="Source" value={f.source ?? "—"} />
          <Field label="Updated" value={fmtTime(f.updatedAt)} />
          <Block label="Value" text={f.value} />
        </>
      );
      break;
    }
    case "project": {
      const p = target.data;
      title = p.name;
      subtitle = `${p.slug} · ${p.status}`;
      body = (
        <>
          <Field label="Slug" value={p.slug} mono />
          <Field label="Type" value={p.type} />
          <Field label="Status" value={p.status} />
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
                    onClick={() => onOpenPage?.(pg.id)}
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
        <div className="insp-body">{body}</div>
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
