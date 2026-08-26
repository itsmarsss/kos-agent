import type { MarkdownWidget, StatWidget } from "@kos/shared";
import type { ReactElement } from "react";

import { CardWidget } from "./CardWidget.js";
import { Chart } from "./Chart.js";
import { CustomHtml } from "./CustomHtml.js";
import { formatCell, humanize } from "./format.js";
import { ListWidget } from "./ListWidget.js";
import { RecordForm } from "./RecordForm.js";
import type { WidgetProps, WidgetRenderer } from "./types.js";

/**
 * The fixed widget library: presentation-first renderers for each widget type.
 * Display widgets are given the rows fetched for their query; write-capable ones
 * are given the guarded mutation runner. An unknown type renders a safe
 * placeholder, never a crash.
 */

export type { Row, WidgetMutation, WidgetProps, WidgetRenderer } from "./types.js";

function Stat({ widget, rows }: WidgetProps): ReactElement {
  const w = widget as StatWidget;
  const first = rows[0] ?? {};
  const value = Object.values(first)[0];
  return (
    <div className="kos-widget kos-stat">
      <div className="kos-stat-label">{w.label}</div>
      <div className="kos-stat-value">{value === undefined ? "-" : formatCell(value)}</div>
    </div>
  );
}

function Table({ widget, rows }: WidgetProps): ReactElement {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  return (
    <div className="kos-widget kos-table-widget">
      {widget.title ? <div className="kos-widget-title">{widget.title}</div> : null}
      <table className="kos-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{humanize(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{formatCell(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Markdown({ widget }: WidgetProps): ReactElement {
  const w = widget as MarkdownWidget;
  // Plain text render (no HTML injection); a markdown lib can replace this.
  return <div className="kos-widget kos-markdown">{w.content}</div>;
}

function Placeholder({ widget }: WidgetProps): ReactElement {
  return (
    <div className="kos-widget kos-placeholder">
      unsupported widget: {widget.type}
    </div>
  );
}

const REGISTRY: Record<string, WidgetRenderer> = {
  stat: Stat,
  table: Table,
  list: ListWidget,
  markdown: Markdown,
  chart: Chart,
  card: CardWidget,
  form: RecordForm,
  custom_html: CustomHtml,
};

/** Look up a widget renderer; unknown types get the safe placeholder. */
export function widgetRenderer(type: string): WidgetRenderer {
  return REGISTRY[type] ?? Placeholder;
}
