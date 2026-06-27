import { isValidPageSpec, validatePageSpec, type PageSpec } from "@kos/shared";
import type { ReactElement } from "react";

import { ErrorBoundary } from "./ErrorBoundary.js";
import { widgetRenderer, type Row } from "./widgets.js";

export interface PageRendererProps {
  spec: PageSpec;
  /** Rows per widget, keyed by widget index (fetched by query elsewhere). */
  data?: Record<number, Row[]>;
}

/**
 * Render an agent-authored page spec from the fixed widget library. The spec is
 * validated first (a bad page is bad data, flagged, not a broken build), and
 * each widget renders inside its own error boundary so one failure is contained.
 */
export function PageRenderer({ spec, data = {} }: PageRendererProps): ReactElement {
  if (!isValidPageSpec(spec)) {
    return (
      <div className="kos-page-invalid" role="alert">
        <strong>Invalid page “{spec?.id ?? "?"}”</strong>
        <ul>
          {validatePageSpec(spec).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="kos-page">
      <h1>{spec.title}</h1>
      {spec.widgets.map((widget, i) => {
        const Renderer = widgetRenderer(widget.type);
        return (
          <ErrorBoundary key={i} label={widget.title ?? widget.type}>
            <Renderer widget={widget} rows={data[i] ?? []} />
          </ErrorBoundary>
        );
      })}
    </div>
  );
}
