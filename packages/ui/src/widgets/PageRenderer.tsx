import { isValidPageSpec, validatePageSpec, type PageSpec } from "@kos/shared";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { api, type MutateKey, type MutateOp } from "../api.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import type { Row, WidgetMutation } from "./types.js";
import { widgetRenderer } from "./widgets.js";

export interface PageRendererProps {
  spec: PageSpec;
  /** Rows per widget, keyed by widget index (fetched by query elsewhere). */
  data?: Record<number, Row[]>;
  /**
   * Per-widget display-query failures, keyed by widget index. A failed query
   * must read as broken, not as an empty result: silent emptiness is how a
   * bad query looks exactly like a table with no rows.
   */
  errors?: Record<number, string>;
  /** Runs one guarded mutation; defaults to the dashboard API client. */
  onMutate?: (
    pageId: string,
    widgetIndex: number,
    op: MutateOp,
    values?: Record<string, unknown>,
    key?: MutateKey,
  ) => Promise<void>;
  /**
   * Refetches the page's rows after a write; defaults to the page endpoint.
   * The whole page, not one widget: a write changes every widget reading that
   * table, and the widget that did the writing is usually a form with no rows
   * of its own.
   */
  onRefresh?: (pageId: string) => Promise<Record<number, Row[]>>;
}

async function defaultMutate(
  pageId: string,
  widgetIndex: number,
  op: MutateOp,
  values?: Record<string, unknown>,
  key?: MutateKey,
): Promise<void> {
  // The server resolves the target table and editable columns from the stored
  // spec, so the request carries neither: only which widget asked for what.
  await api.mutate({
    pageId,
    widgetIndex,
    op,
    ...(values ? { values } : {}),
    ...(key ? { key } : {}),
  });
}

async function defaultRefresh(pageId: string): Promise<Record<number, Row[]>> {
  const payload = await api.page(pageId);
  return payload.data;
}

/**
 * Default width per widget type. A stat is a few words and reads as a tile;
 * a chart or table needs the full row to be legible. Stacking everything full
 * width turns a five-widget page into three screens of scrolling.
 */
const DEFAULT_SPAN: Record<string, string> = {
  stat: "quarter",
  form: "half",
  markdown: "half",
  list: "half",
  card: "full",
  table: "full",
  chart: "full",
  custom_html: "full",
};

function spanOf(widget: { type: string; span?: string }): string {
  return widget.span ?? DEFAULT_SPAN[widget.type] ?? "full";
}

/** Stable identity so the default never looks like fresh data every render. */
const NO_DATA: Record<number, Row[]> = {};
const NO_ERRORS: Record<number, string> = {};

/**
 * Render an agent-authored page spec from the fixed widget library. The spec is
 * validated first (a bad page is bad data, flagged, not a broken build), and
 * each widget renders inside its own error boundary so one failure is contained.
 * Write-capable widgets get a mutation runner scoped to their own index; once
 * the write lands the page's rows are refetched, so the table and the total
 * that read the same records move together with the form that changed them.
 */
export function PageRenderer({
  spec,
  data = NO_DATA,
  errors = NO_ERRORS,
  onMutate = defaultMutate,
  onRefresh = defaultRefresh,
}: PageRendererProps): ReactElement {
  const [fresh, setFresh] = useState<Record<number, Row[]>>({});

  // Rows fetched after a write are dropped when the page reloads from upstream.
  useEffect(() => {
    setFresh((prev) => (Object.keys(prev).length > 0 ? {} : prev));
  }, [data, spec.id]);

  const runMutation = useCallback(
    async (
      widgetIndex: number,
      op: MutateOp,
      values?: Record<string, unknown>,
      key?: MutateKey,
    ): Promise<void> => {
      await onMutate(spec.id, widgetIndex, op, values, key);
      setFresh(await onRefresh(spec.id));
    },
    [spec.id, onMutate, onRefresh],
  );

  const widgetCount = spec?.widgets?.length ?? 0;
  const mutations = useMemo<WidgetMutation[]>(
    () =>
      Array.from({ length: widgetCount }, (_, i) => ({
        run: (op: MutateOp, values?: Record<string, unknown>, key?: MutateKey) =>
          runMutation(i, op, values, key),
      })),
    [widgetCount, runMutation],
  );

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
        const failed = errors[i];
        return (
          <div className={`kos-cell kos-cell--${spanOf(widget)}`} key={i}>
          <ErrorBoundary label={widget.title ?? widget.type}>
            {failed ? (
              <div className="kos-widget kos-widget-failed" role="alert">
                <div className="kos-widget-title">
                  {widget.title ?? widget.type}
                </div>
                <div className="kos-error">query failed: {failed}</div>
              </div>
            ) : (
              <Renderer
                widget={widget}
                rows={fresh[i] ?? data[i] ?? []}
                mutate={mutations[i]}
              />
            )}
          </ErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}
