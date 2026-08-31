import type { MarkdownWidget, StatWidget } from "@kos/shared";
import type { ReactElement } from "react";

import { CardWidget } from "./CardWidget.js";
import { Chart } from "./Chart.js";
import { CustomHtml } from "./CustomHtml.js";
import { formatCell, humanize } from "./format.js";
import { ListWidget } from "./ListWidget.js";
import { Markdown as MarkdownText } from "../Markdown.js";
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
  // SUM over no rows is null, and formatCell renders null as "" -- right for a
  // table cell, but a stat whose number is an empty string just looks broken.
  const text = value === undefined || value === null ? "-" : formatCell(value);
  return (
    <div className="kos-widget kos-stat">
      <div className="kos-stat-label">{w.label}</div>
      <div className="kos-stat-value">{text}</div>
    </div>
  );
}

function Table({ widget, rows }: WidgetProps): ReactElement {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  // Columns come from the first row, so an empty result has none either: the
  // widget rendered as a bare title over nothing at all. A tracker is empty
  // on the day it is built, which is exactly when this is first seen.
  if (rows.length === 0) {
    return (
      <div className="kos-widget kos-table-widget">
        {widget.title ? <div className="kos-widget-title">{widget.title}</div> : null}
        <div className="kos-empty">nothing here yet</div>
      </div>
    );
  }
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
  // The same element-building renderer chat uses: no dangerouslySetInnerHTML,
  // so agent-authored text still cannot inject markup. Rendering it as plain
  // text meant a markdown widget showed its own asterisks.
  return (
    <div className="kos-widget kos-markdown">
      <MarkdownText text={w.content} />
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
