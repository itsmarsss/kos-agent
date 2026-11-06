/**
 * What KOS makes for the owner to read and use: artifacts. Every artifact is
 * one HTML document in the same sandboxed frame (artifactdoc.ts), reaching
 * data only through window.kos. Its kind says which runtime KOS inlines
 * beside it and which design defaults it starts from; the agent writes
 * content in the kind's simple structure and the runtime does the hard parts.
 *
 *  - page:  an app, dashboard or tool. No runtime: the kit's look and the
 *           react and charts libraries, as pages always had.
 *  - doc:   a designed document. kos-doc numbers footnotes and figures,
 *           builds a table of contents for a long one, and lets the owner
 *           edit the text in place, each edit kept as a version.
 *  - deck:  slides. kos-deck fits each 16:9 slide to the frame, and gives
 *           keyboard, click and swipe navigation, a counter, a grid of
 *           slides, presenter notes and presenting.
 *  - sheet: a spreadsheet. kos-sheet draws a typed grid with formulas,
 *           sorting, filtering, frozen headers, number formats and charts,
 *           over a project's table or data kept with the artifact.
 */

export const ARTIFACT_KINDS = ["page", "doc", "deck", "sheet"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const isArtifactKind = (v: unknown): v is ArtifactKind => (ARTIFACT_KINDS as readonly unknown[]).includes(v);

/**
 * The workspace where a project is named: in artifacts.list's filter, in
 * artifacts.write to move an artifact out of its project, and in the
 * gallery's filter. A slug is lowercase letters, digits and _, so this can
 * never be one; "workspace" could.
 */
export const WORKSPACE_SCOPE = "@workspace";

/** The runtime KOS inlines for a kind, served beside the libraries as /page-lib/<name>.js. */
export const KIND_RUNTIME: Record<ArtifactKind, string | undefined> = {
  page: undefined,
  doc: "kos-doc",
  deck: "kos-deck",
  sheet: "kos-sheet",
};

/** The fonts a kind starts from when the artifact names none (artifactfonts.ts). */
export const KIND_FONTS: Record<ArtifactKind, readonly string[]> = {
  page: [],
  doc: ["newsreader", "public-sans", "ibm-plex-mono"],
  deck: ["bricolage-grotesque", "public-sans"],
  sheet: ["public-sans", "ibm-plex-mono"],
};

/**
 * The structure each runtime reads, as the agent writes it. The guide
 * (artifacts.guide) teaches these; the runtimes and the store hold to them.
 *
 * doc:   one `<article data-doc>` holding the document: a header with an
 *        h1 and a `.lede`, h2 sections, `<span class="fn">` footnotes
 *        inline, `<figure>` with `<figcaption>`, `<blockquote class="pull">`.
 *        No `<article>` nested inside it. Editing replaces its inner HTML.
 * deck:  one `<main data-deck>` holding a `<section>` per slide; a slide's
 *        presenter notes are an `<aside class="notes">` inside it.
 * sheet: one `<script type="application/json" data-sheet>` holding the
 *        workbook (SheetBook); the grid is drawn after it. Editing data kept
 *        with the artifact replaces that script's JSON.
 */
export const DOC_REGION = "data-doc";
export const DECK_REGION = "data-deck";
export const SHEET_DATA = "data-sheet";

/** A column's type: how its values are read, aligned and shown. */
export type SheetColumnType = "text" | "number" | "currency" | "percent" | "date" | "bool";

export interface SheetColumn {
  label: string;
  type?: SheetColumnType;
  /** Decimal places for number, currency and percent. */
  decimals?: number;
  /** An ISO 4217 code for currency; CAD, USD, EUR... */
  currency?: string;
  /** Width in characters, when the default is wrong. */
  width?: number;
  /** For a sheet over a table: the table's column this one shows. */
  column?: string;
}

/** A cell as stored: a value, or a formula starting with "=". */
export type SheetCell = string | number | boolean | null;

export type SheetAggregate = "sum" | "average" | "min" | "max" | "count";

export interface SheetTab {
  name: string;
  /** The tab's columns; a pivot tab may leave them out, or declare some to name and format them. */
  columns: SheetColumn[];
  /** Data kept with the artifact. One of rows, source or pivot. */
  rows?: SheetCell[][];
  /** Rows read live from a project table through window.kos. */
  source?: { table: string; key: string; orderBy?: string };
  /** Rows grouped from another tab: by one column, aggregating others. */
  pivot?: { from: string; by: string; values: { column: string; fn: SheetAggregate }[] };
  /** A totals row under the grid, by column label or letter. */
  totals?: Record<string, SheetAggregate>;
  /** Columns kept in view while scrolling sideways, counted from the left. */
  freeze?: number;
}

export interface SheetChart {
  type: "bar" | "line" | "pie";
  title: string;
  /** The tab whose ranges these are; the first tab when absent. */
  sheet?: string;
  /** A1-style ranges, one column each: the labels and the values. */
  labels: string;
  values: string;
}

/** The workbook a sheet artifact keeps in its data script. */
export interface SheetBook {
  sheets: SheetTab[];
  charts?: SheetChart[];
}

/** An owner's edit made in a runtime, which becomes the artifact's next version. */
export type ArtifactEdit = { doc: string } | { sheet: SheetBook };

const COLUMN_TYPES: readonly SheetColumnType[] = ["text", "number", "currency", "percent", "date", "bool"];
const AGGREGATES: readonly SheetAggregate[] = ["sum", "average", "min", "max", "count"];
/** Enough for a real ledger; a bigger one belongs in a project table. */
export const SHEET_ROWS_MAX = 5000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What is wrong with a sheet's workbook, as sentences the agent can act on; empty when it is fine. */
export function sheetErrors(book: unknown): string[] {
  if (!isObject(book) || !Array.isArray(book.sheets) || book.sheets.length === 0) return ["the sheet's data needs sheets: a list of at least one tab"];
  const errors: string[] = [];
  const names = new Set<string>();
  book.sheets.forEach((raw: unknown, i: number) => {
    const at = `sheets[${i}]`;
    if (!isObject(raw)) return void errors.push(`${at} must be an object`);
    if (typeof raw.name !== "string" || !raw.name.trim()) errors.push(`${at} needs a name`);
    else if (names.has(raw.name)) errors.push(`${at}: two tabs are called "${raw.name}"`);
    else names.add(raw.name);
    // A pivot works its columns out from what it groups; declared ones only name and format them.
    const derived = raw.pivot !== undefined && (raw.columns === undefined || (Array.isArray(raw.columns) && raw.columns.length === 0));
    if (!derived && (!Array.isArray(raw.columns) || raw.columns.length === 0)) errors.push(`${at} needs columns`);
    else if (Array.isArray(raw.columns))
      raw.columns.forEach((c: unknown, j: number) => {
        if (!isObject(c) || typeof c.label !== "string" || !c.label) errors.push(`${at}.columns[${j}] needs a label`);
        else if (c.type !== undefined && !COLUMN_TYPES.includes(c.type as SheetColumnType)) errors.push(`${at}.columns[${j}].type is one of ${COLUMN_TYPES.join(", ")}`);
      });
    const sources = ["rows", "source", "pivot"].filter((k) => raw[k] !== undefined);
    if (sources.length !== 1) errors.push(`${at} takes exactly one of rows, source or pivot`);
    if (raw.rows !== undefined) {
      if (!Array.isArray(raw.rows) || raw.rows.some((r) => !Array.isArray(r))) errors.push(`${at}.rows is a list of rows, each a list of cells`);
      else if (raw.rows.length > SHEET_ROWS_MAX) errors.push(`${at} has ${raw.rows.length} rows; keep more than ${SHEET_ROWS_MAX} in a project table and use source`);
    }
    if (raw.source !== undefined && (!isObject(raw.source) || typeof raw.source.table !== "string" || typeof raw.source.key !== "string")) {
      errors.push(`${at}.source needs a table and its key column`);
    }
    if (raw.pivot !== undefined && (!isObject(raw.pivot) || typeof raw.pivot.from !== "string" || typeof raw.pivot.by !== "string" || !Array.isArray(raw.pivot.values))) {
      errors.push(`${at}.pivot needs from, by and values`);
    }
    if (raw.totals !== undefined && (!isObject(raw.totals) || Object.values(raw.totals).some((fn) => !AGGREGATES.includes(fn as SheetAggregate)))) {
      errors.push(`${at}.totals maps columns to one of ${AGGREGATES.join(", ")}`);
    }
  });
  if (book.charts !== undefined) {
    if (!Array.isArray(book.charts)) errors.push("charts must be a list");
    else
      book.charts.forEach((c: unknown, i: number) => {
        if (!isObject(c) || !["bar", "line", "pie"].includes(c.type as string) || typeof c.labels !== "string" || typeof c.values !== "string") {
          errors.push(`charts[${i}] needs a type (bar, line or pie), labels and values ranges`);
        }
      });
  }
  return errors;
}

/** The project tables a workbook reads live. */
export const sheetTables = (book: SheetBook): string[] => book.sheets.flatMap((s) => (s.source ? [s.source.table] : []));

/**
 * What an artifact's frame needs fetched before it can be drawn: the
 * libraries it named and its kind's runtime (each /page-lib/<name>.js), and
 * the bundled fonts it named, or its kind's own when it named none.
 */
export function artifactAssets(page: { kind?: ArtifactKind; libraries?: readonly string[]; fonts?: readonly string[] }): { scripts: string[]; fonts: string[] } {
  const kind = page.kind ?? "page";
  const runtime = KIND_RUNTIME[kind];
  return {
    scripts: [...(page.libraries ?? []), ...(runtime ? [runtime] : [])],
    fonts: [...(page.fonts?.length ? page.fonts : KIND_FONTS[kind])],
  };
}
