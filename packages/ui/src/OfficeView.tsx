import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";

import type { DocView, OfficeView, PictureView, SheetView, SlideShape, SlidesView, ViewCell } from "@kos/shared";
import { Skeleton } from "@kos/kit";

import { api } from "./api.js";

/**
 * An Office file drawn in the dashboard: a document as a page, a workbook as
 * sheets, a deck as slides, and a picture where that is what the host could
 * make. The server converts the file once per version (/api/file/office);
 * this only draws what came back.
 *
 * A document's HTML is drawn in a frame that runs no script, loads nothing
 * from anywhere and has an origin of its own, on top of the server having
 * cleaned it: two fences, so neither has to be perfect.
 */

const VIEWABLE = new Set([
  "docx", "docm", "dotx", "doc", "dot", "rtf", "odt", "pages",
  "xlsx", "xlsm", "xltx", "xlsb", "xls", "ods", "csv", "tsv", "numbers",
  "pptx", "pptm", "potx", "ppsx", "ppt", "pps", "odp", "key",
]);

/** Whether the viewers draw a file of this name. */
export function isOfficePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && VIEWABLE.has(path.slice(dot + 1).toLowerCase());
}

/** The file, fetched as its view and drawn; `version` changes when the file does, to fetch it again. */
export function OfficeBody({ path, version }: { path: string; version?: string }): ReactElement {
  const [view, setView] = useState<OfficeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void api
      .officeView(path)
      .then((v) => !cancelled && setView(v))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  // A step to another file starts blank, not on the last file's view.
  useEffect(() => setView(null), [path]);

  if (error) return <p className="hint preview-hint office-error">{error}</p>;
  if (!view) return <Skeleton className="office-loading" />;
  return (
    <div className={`office office--${view.kind}`}>
      {view.notes.length > 0 && <p className="office-note">{view.notes.join(" ")}</p>}
      {view.kind === "doc" && <DocFrame view={view} />}
      {view.kind === "sheet" && <SheetGrid view={view} />}
      {view.kind === "slides" && <SlideDeck view={view} />}
      {view.kind === "picture" && <PictureFrame view={view} />}
    </div>
  );
}

/** The paper a document is drawn on; the frame's own, so the document's CSS never reaches the dashboard. */
const PAPER = `
html { background: var(--ground, #e6e7ea); }
body { margin: 0; padding: 24px 16px 40px; font: 11pt/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, system-ui, sans-serif; color: #1d1d1f; }
.page { box-sizing: border-box; max-width: 816px; min-height: 400px; margin: 0 auto; padding: 72px 80px; background: #fff; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,.18), 0 8px 24px rgba(0,0,0,.12); overflow-wrap: anywhere; }
.page > :first-child { margin-top: 0; }
h1 { font-size: 20pt; font-weight: 600; margin: 0 0 12px; line-height: 1.2; }
h2 { font-size: 15pt; font-weight: 600; margin: 18px 0 8px; }
h3, h4, h5, h6 { font-size: 12pt; font-weight: 600; margin: 14px 0 6px; }
p { margin: 0 0 8px; }
ul, ol { margin: 0 0 8px; padding-left: 28px; }
table { border-collapse: collapse; margin: 8px 0 12px; max-width: 100%; }
td, th { border: 1px solid #c9ccd3; padding: 4px 8px; vertical-align: top; }
td > p:last-child, th > p:last-child { margin-bottom: 0; }
img { max-width: 100%; height: auto; }
blockquote { margin: 8px 0; padding-left: 14px; border-left: 3px solid #d0d4dc; color: #4a4f5a; }
.link { color: #1f5fd1; text-decoration: underline; }
.tab { display: inline-block; width: 3em; }
@media (max-width: 600px) { body { padding: 0; } .page { padding: 28px 20px; border-radius: 0; box-shadow: none; } }
`;

/** A document's whole frame: a policy that allows inline style and data pictures, and nothing that loads or runs. */
export function docDocument(html: string, ground = ""): string {
  const desk = /^#[0-9a-f]{3,8}$/i.test(ground) ? `:root{--ground:${ground}}` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width"><style>${desk}${PAPER}</style></head><body><main class="page">${html}</main></body></html>`;
}

function DocFrame({ view }: { view: DocView }): ReactElement {
  // The page lies on the dashboard's own ground, read once: the frame cannot see the theme's tokens.
  const doc = useMemo(() => docDocument(view.html, getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), [view.html]);
  // No allow-* at all: no script, no forms, no popups, no same origin.
  return <iframe className="office-doc" sandbox="" srcDoc={doc} title="Document" />;
}

/** A column's letters, as a spreadsheet heads it: A, B, … Z, AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Rows drawn at a time; more come as the grid scrolls near its end. */
const ROWS_PAGE = 200;

/** Whether a sheet's first row reads as its header: words over a row that is not all words. */
function headed(rows: (ViewCell | null)[][]): boolean {
  const [first, second] = rows;
  if (!first || !second) return false;
  const cells = first.filter((c): c is ViewCell => c !== null);
  return cells.length > 1 && cells.every((c) => c.t === "s") && second.some((c) => c && c.t !== "s");
}

function SheetGrid({ view }: { view: SheetView }): ReactElement {
  const [tab, setTab] = useState(0);
  const sheet = view.sheets[Math.min(tab, view.sheets.length - 1)];
  const [limit, setLimit] = useState(ROWS_PAGE);
  useEffect(() => setLimit(ROWS_PAGE), [tab]);
  const end = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el) return undefined;
    const seen = new IntersectionObserver((records) => {
      if (records.some((r) => r.isIntersecting)) setLimit((l) => l + ROWS_PAGE);
    }, { rootMargin: "400px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [limit, tab]);

  if (!sheet) return <p className="hint preview-hint">This workbook has no sheets to show.</p>;
  const head = headed(sheet.rows);
  /** Cells a merge covers are not drawn; the merge's first cell spans them. */
  const covered = new Set<string>();
  const spans = new Map<string, { rows: number; cols: number }>();
  for (const m of sheet.merges ?? []) {
    spans.set(`${m.r}:${m.c}`, { rows: m.rows, cols: m.cols });
    for (let r = m.r; r < m.r + m.rows; r++) for (let c = m.c; c < m.c + m.cols; c++) if (r !== m.r || c !== m.c) covered.add(`${r}:${c}`);
  }
  /** Columns that hold figures: their header sits right, over them. */
  const figures = new Set<number>();
  if (head) {
    for (let c = 0; c < sheet.cols; c++) {
      const below = sheet.rows.slice(1, 50).map((row) => row[c]).filter((v): v is ViewCell => !!v);
      if (below.length && below.filter((v) => v.t === "n" || v.t === "d").length * 2 > below.length) figures.add(c);
    }
  }
  const cell = (value: ViewCell | null, r: number, c: number): ReactElement | null => {
    if (covered.has(`${r}:${c}`)) return null;
    const span = spans.get(`${r}:${c}`);
    const kind = head && r === 0 ? (figures.has(c) ? "num" : "") : value ? (value.t === "n" || value.t === "d" ? "num" : value.t === "b" ? "bool" : value.t === "e" ? "err" : "") : "";
    const Tag = head && r === 0 ? "th" : "td";
    return (
      <Tag key={c} className={kind || undefined} {...(span ? { rowSpan: span.rows, colSpan: span.cols } : {})} title={value && value.v.length > 24 ? value.v : undefined}>
        {value?.v}
      </Tag>
    );
  };
  const shown = sheet.rows.slice(0, limit);
  const widths = sheet.widths;
  return (
    <div className="ov-sheet">
      {view.sheets.length > 1 && (
        <div className="ov-sheet-tabs" role="tablist" aria-label="Sheets">
          {view.sheets.map((s, i) => (
            <button key={s.name} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet.rows.length === 0 ? (
        <p className="hint preview-hint">This sheet is empty.</p>
      ) : (
        <div className="ov-sheet-scroll">
          <table className={`ov-sheet-grid${head ? " ov-sheet-grid--headed" : ""}`}>
            <colgroup>
              <col className="ov-rownum-col" />
              {Array.from({ length: sheet.cols }, (_, c) => (
                <col key={c} style={widths?.[c] ? { width: `${widths[c]}px` } : undefined} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="ov-rownum" aria-label="Row" />
                {Array.from({ length: sheet.cols }, (_, c) => (
                  <th key={c} className="ov-letter" scope="col">
                    {columnName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, r) => (
                <tr key={r} ref={r === shown.length - 1 && shown.length < sheet.rows.length ? end : undefined} className={head && r === 0 ? "ov-head-row" : undefined}>
                  <th className="ov-rownum" scope="row">
                    {r + 1}
                  </th>
                  {row.map((value, c) => cell(value, r, c))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function shapeStyle(s: SlideShape): CSSProperties {
  return { left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` };
}

function Shape({ shape }: { shape: SlideShape }): ReactElement {
  if (shape.kind === "picture") return <img className="ov-shape" style={shapeStyle(shape)} src={shape.src} alt="" draggable={false} />;
  if (shape.kind === "box") {
    return <div className={`ov-shape${shape.round ? " ov-shape--round" : ""}`} style={{ ...shapeStyle(shape), background: shape.fill, ...(shape.line ? { boxShadow: `inset 0 0 0 1px ${shape.line}` } : {}) }} />;
  }
  if (shape.kind === "table") {
    return (
      <div className="ov-shape ov-shape-table" style={shapeStyle(shape)}>
        <table>
          <tbody>
            {shape.rows.map((row, r) => (
              <tr key={r}>
                {row.map((text, c) => (
                  <td key={c}>{text}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className={`ov-shape ov-text ov-text--${shape.anchor ?? "top"}`} style={{ ...shapeStyle(shape), background: shape.fill, ...(shape.line ? { boxShadow: `inset 0 0 0 1px ${shape.line}` } : {}) }}>
      {shape.paragraphs.map((p, i) => (
        <p key={i} className={p.bullet ? "ov-bullet" : undefined} style={{ textAlign: p.align, paddingLeft: p.level ? `${p.level * 1.6}em` : undefined, fontSize: `calc(${p.runs[0]?.size ?? 0.025} * 100cqw)` }}>
          {p.runs.length === 0 && " "}
          {p.runs.map((r, j) =>
            r.text === "\n" ? (
              <br key={j} />
            ) : (
              <span key={j} style={{ fontSize: r.size ? `calc(${r.size} * 100cqw)` : undefined, fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? "italic" : undefined, textDecoration: r.underline ? "underline" : undefined, color: r.color }}>
                {r.text}
              </span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/** A slide drawn at whatever width it is given: its words sized as fractions of that width. */
export function SlideStage({ view, index }: { view: SlidesView; index: number }): ReactElement {
  const slide = view.slides[index]!;
  return (
    <div className="ov-slide" style={{ aspectRatio: String(view.aspect), background: slide.background ?? "#fff" }} role="img" aria-label={slide.title || `Slide ${index + 1}`}>
      {slide.shapes.map((s, i) => (
        <Shape key={i} shape={s} />
      ))}
    </div>
  );
}

function SlideDeck({ view }: { view: SlidesView }): ReactElement {
  if (view.slides.length === 0) return <p className="hint preview-hint">This deck has no slides.</p>;
  return (
    <ol className="ov-deck">
      {view.slides.map((slide, i) => (
        <li key={i} className="ov-deck-slide">
          <SlideStage view={view} index={i} />
          <div className="ov-slide-foot">
            <span className="ov-slide-n">{i + 1}</span>
            {slide.notes && <p className="ov-slide-notes">{slide.notes}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function PictureFrame({ view }: { view: PictureView }): ReactElement {
  return <img className="ov-picture" src={view.src} alt="" />;
}
