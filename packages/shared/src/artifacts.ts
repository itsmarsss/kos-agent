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
