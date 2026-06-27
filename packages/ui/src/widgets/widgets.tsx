import type { Widget } from "@kos/shared";
import type { ReactElement } from "react";

/**
 * The fixed widget library: presentation-first renderers for each widget type.
 * Display widgets are given the rows fetched for their query; an unknown type
 * renders a safe placeholder, never a crash. These are intentionally simple and
 * dependency-free (a real chart lib can drop in later).
 */

export type Row = Record<string, unknown>;

export interface WidgetProps {
  widget: Widget;
  rows: Row[];
}

function Stat({ widget, rows }: WidgetProps): ReactElement {
  const w = widget as Extract<Widget, { type: "stat" }>;
  const first = rows[0] ?? {};
  const value = Object.values(first)[0];
  return (
    <div className="kos-widget kos-stat">
      <div className="kos-stat-label">{w.label}</div>
      <div className="kos-stat-value">{value === undefined ? "-" : String(value)}</div>
    </div>
  );
}

function Table({ rows }: WidgetProps): ReactElement {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  return (
    <table className="kos-widget kos-table">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {cols.map((c) => (
              <td key={c}>{String(r[c] ?? "")}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ListWidget({ rows }: WidgetProps): ReactElement {
  return (
    <ul className="kos-widget kos-list">
      {rows.map((r, i) => (
        <li key={i}>{String(Object.values(r)[0] ?? "")}</li>
      ))}
    </ul>
  );
}

function Markdown({ widget }: WidgetProps): ReactElement {
  const w = widget as Extract<Widget, { type: "markdown" }>;
  // Plain text render (no HTML injection); a markdown lib can replace this.
  return <div className="kos-widget kos-markdown">{w.content}</div>;
}

function ChartPlaceholder({ widget, rows }: WidgetProps): ReactElement {
  const w = widget as Extract<Widget, { type: "chart" }>;
  return (
    <div className="kos-widget kos-chart">
      <div className="kos-chart-kind">{w.kind} chart</div>
      <div className="kos-chart-points">{rows.length} points</div>
    </div>
  );
}

function Card({ rows }: WidgetProps): ReactElement {
  return (
    <div className="kos-widget kos-cards">
      {rows.map((r, i) => (
        <div className="kos-card" key={i}>
          {Object.entries(r).map(([k, v]) => (
            <div key={k}>
              <span className="kos-card-key">{k}</span>: {String(v ?? "")}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Placeholder({ widget }: WidgetProps): ReactElement {
  return (
    <div className="kos-widget kos-placeholder">
      unsupported widget: {widget.type}
    </div>
  );
}

const REGISTRY: Record<string, (props: WidgetProps) => ReactElement> = {
  stat: Stat,
  table: Table,
  list: ListWidget,
  markdown: Markdown,
  chart: ChartPlaceholder,
  card: Card,
};

/** Look up a widget renderer; unknown types get the safe placeholder. */
export function widgetRenderer(type: string): (props: WidgetProps) => ReactElement {
  return REGISTRY[type] ?? Placeholder;
}
