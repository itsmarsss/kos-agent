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

/**
 * How much of the page row a widget occupies. The agent chooses the shape of
 * its own page; when it says nothing, the renderer picks a sane default from
 * the widget type (a stat is a tile, a chart wants room).
 */
export type WidgetSpan = "quarter" | "third" | "half" | "full";

export interface BaseWidget {
  type: WidgetType;
  id?: string;
  title?: string;
  span?: WidgetSpan;
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
  /** Frame height in px. Interactive pages need room; default 320. */
  height?: number;
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

/**
 * The home layout.
 *
 * Home is not a fixed page: it is a list of panels the owner arranges. The
 * existing widget types are all backed by a SQL query against a project's
 * tables, which is right for a project dashboard and wrong for the first thing
 * you see, where what matters is what needs you, what is running, and what
 * broke. Those live in the app rather than in any project table, so they are
 * named rather than queried.
 */
export type PanelKind =
  | "approvals"
  | "agents"
  | "failures"
  | "activity"
  | "projects"
  | "chats"
  | "schedule"
  | "spend"
  | "memory"
  | "modules"
  | "note";

export interface HomePanel {
  /** Stable across reorders, so React and the editor can track one panel. */
  id: string;
  kind: PanelKind;
  /** Overrides the panel's own name, when the owner wants different words. */
  title?: string;
  span: WidgetSpan;
  /** Rows shown, where the panel is a list. */
  limit?: number;
  /** Body of a note panel. */
  text?: string;
}

export interface HomeLayout {
  panels: HomePanel[];
}

const PANEL_KINDS: PanelKind[] = [
  "approvals",
  "agents",
  "failures",
  "activity",
  "projects",
  "chats",
  "schedule",
  "spend",
  "memory",
  "modules",
  "note",
];

const SPANS: WidgetSpan[] = ["quarter", "third", "half", "full"];

/**
 * What a new workspace opens on.
 *
 * Ordered by how much it wants you: things waiting on a decision, then things
 * running, then what went wrong, then what happened. A project grid is further
 * down because projects are somewhere you go, not something you watch.
 */
export const DEFAULT_HOME: HomeLayout = {
  panels: [
    { id: "approvals", kind: "approvals", span: "full" },
    { id: "agents", kind: "agents", span: "half" },
    { id: "failures", kind: "failures", span: "half", limit: 5 },
    { id: "memory", kind: "memory", span: "half" },
    { id: "modules", kind: "modules", span: "half" },
    { id: "projects", kind: "projects", span: "full" },
    { id: "activity", kind: "activity", span: "half", limit: 8 },
    { id: "chats", kind: "chats", span: "half", limit: 6 },
  ],
};

/**
 * Read a stored layout, dropping anything unrecognised.
 *
 * A layout that cannot be parsed is replaced by the default rather than
 * throwing: a corrupt setting should not leave the owner with no home page.
 */
export function parseHomeLayout(raw: unknown): HomeLayout {
  if (typeof raw !== "object" || raw === null) return DEFAULT_HOME;
  const panels = (raw as { panels?: unknown }).panels;
  if (!Array.isArray(panels)) return DEFAULT_HOME;

  const seen = new Set<string>();
  const out: HomePanel[] = [];
  for (const entry of panels) {
    if (typeof entry !== "object" || entry === null) continue;
    const p = entry as Record<string, unknown>;
    const kind = p["kind"];
    if (typeof kind !== "string" || !PANEL_KINDS.includes(kind as PanelKind)) continue;
    // Ids must be unique or the editor cannot tell two panels apart.
    let id = typeof p["id"] === "string" && p["id"] ? p["id"] : kind;
    while (seen.has(id)) id = `${id}-${seen.size}`;
    seen.add(id);
    const span = SPANS.includes(p["span"] as WidgetSpan)
      ? (p["span"] as WidgetSpan)
      : "half";
    const limit = Number(p["limit"]);
    out.push({
      id,
      kind: kind as PanelKind,
      span,
      ...(typeof p["title"] === "string" && p["title"] ? { title: p["title"] } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.floor(limit) } : {}),
      ...(typeof p["text"] === "string" ? { text: p["text"] } : {}),
    });
  }
  // An empty layout is a home page with nothing on it, which is a state the
  // owner can reach deliberately by removing every panel.
  return { panels: out };
}
