/**
 * What an Office file is shown as: one of four views, plain JSON, the same
 * for the dashboard and KOS for iPhone. Nothing in it runs: a document is
 * HTML already cleaned to an allow-list, a sheet and a deck are data, and a
 * picture is a data URI of a raster type. Documented in docs/files.md.
 */

export type ViewFormat =
  | "docx" | "doc" | "rtf" | "odt" | "pages"
  | "xlsx" | "xls" | "ods" | "csv" | "tsv" | "numbers"
  | "pptx" | "ppt" | "odp" | "key";

export type OfficeView = DocView | SheetView | SlidesView | PictureView;

interface ViewBase {
  format: ViewFormat;
  /** What the view leaves out, said to the owner: "Showing the first 2,000 of 90,000 rows." */
  notes: string[];
}

/** A document: an HTML fragment, cleaned (sanitize.ts), with its own small stylesheet when the converter wrote one. */
export interface DocView extends ViewBase {
  kind: "doc";
  html: string;
}

export interface SheetView extends ViewBase {
  kind: "sheet";
  sheets: Sheet[];
}

export interface Sheet {
  name: string;
  /** The rows shown, each as long as `cols`; a gap is null. */
  rows: (Cell | null)[][];
  cols: number;
  /** The sheet's real extent, past what is shown when it was cut. */
  totalRows: number;
  totalCols: number;
  /** Each column's width in pixels, when the file says. */
  widths?: number[];
  /** Merged ranges inside what is shown, zero-based and inclusive. */
  merges?: { r: number; c: number; rows: number; cols: number }[];
}

export interface Cell {
  /** The value as the file formats it: "$12.50", "4/2/26". */
  v: string;
  /** n number, b boolean, e error, d date, s text. */
  t: "n" | "b" | "e" | "d" | "s";
}

export interface SlidesView extends ViewBase {
  kind: "slides";
  /** The slide's shape, width over height. */
  aspect: number;
  slides: Slide[];
}

export interface Slide {
  /** The title placeholder's words, for a list of slides and a reader. */
  title: string;
  background?: string;
  shapes: Shape[];
  notes?: string;
}

/** Where a shape sits, as fractions of the slide's width and height. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Shape =
  | (Frame & { kind: "text"; paragraphs: Paragraph[]; fill?: string; line?: string; anchor?: "top" | "middle" | "bottom" })
  | (Frame & { kind: "picture"; src: string })
  | (Frame & { kind: "box"; fill?: string; line?: string; round?: boolean })
  | (Frame & { kind: "table"; rows: string[][] });

export interface Paragraph {
  runs: Run[];
  align?: "left" | "center" | "right" | "justify";
  level?: number;
  bullet?: boolean;
}

export interface Run {
  text: string;
  /** Font size as a fraction of the slide's width, so a slide draws at any size. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}

/** A picture of the file, when that is the most this host can show: a Keynote or Pages preview, a QuickLook thumbnail. */
export interface PictureView extends ViewBase {
  kind: "picture";
  src: string;
}
