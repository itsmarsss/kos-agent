/**
 * Page-spec contract. The agent authors UI as declarative JSON, never React.
 * A page is a list of widgets the fixed shell renders from a fixed widget
 * library. Display widgets carry a read-only query; write-capable widgets
 * declare a guarded mutation target (table + editable columns), never raw SQL.
 * These types are the contract; validation (below) runs at write time so a bad
 * page is bad data caught before render, not a broken build.
 */

export type WidgetType =
  | "stat"
  | "table"
  | "chart"
  | "list"
  | "markdown"
  | "card"
  | "form"
  | "custom_html";

export type ChartKind = "line" | "bar" | "area" | "pie";

/** A write-capable widget's guarded mutation declaration. */
export interface MutationTarget {
  table: string;
  /** Columns the widget may insert/update. */
  columns: string[];
  /** Mutations the widget may perform; defaults to insert+update. */
  allow?: ("insert" | "update" | "delete")[];
}

export interface BaseWidget {
  type: WidgetType;
  id?: string;
  title?: string;
}

export interface StatWidget extends BaseWidget {
  type: "stat";
  label: string;
  query: string;
}

export interface TableWidget extends BaseWidget {
  type: "table";
  query: string;
}

export interface ChartWidget extends BaseWidget {
  type: "chart";
  kind: ChartKind;
  query: string;
}

export interface ListWidget extends BaseWidget {
  type: "list";
  query: string;
  /** Inline actions mutate the declared target via the guarded path. */
  mutate?: MutationTarget;
}

export interface MarkdownWidget extends BaseWidget {
  type: "markdown";
  content: string;
}

export interface CardWidget extends BaseWidget {
  type: "card";
  query: string;
  mutate?: MutationTarget;
}

export interface FormWidget extends BaseWidget {
  type: "form";
  /** Forms are write-only inputs; a mutation target is required. */
  mutate: MutationTarget;
}

export interface CustomHtmlWidget extends BaseWidget {
  type: "custom_html";
  html: string;
}

export type Widget =
  | StatWidget
  | TableWidget
  | ChartWidget
  | ListWidget
  | MarkdownWidget
  | CardWidget
  | FormWidget
  | CustomHtmlWidget;

export interface PageSpec {
  id: string;
  title: string;
  widgets: Widget[];
}
