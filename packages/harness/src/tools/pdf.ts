/**
 * A table as a PDF, written by hand.
 *
 * The spec names PDF export as open. A library would pull a renderer in for
 * one shape of document, a table of query rows with a title, which the PDF
 * format can carry with a dozen objects: a catalog, a page tree, one font,
 * and a page per sheet of monospaced lines. Courier keeps the columns
 * aligned without measuring glyphs. Text outside Latin-1 becomes "?", which
 * the file says plainly rather than drawing a wrong glyph.
 */

type Row = Record<string, unknown>;

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const FONT_PT = 9;
const LEAD = 12;
const CHAR_W = FONT_PT * 0.6;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEAD) - 2;
const COLS_PER_LINE = Math.floor((PAGE_W - 2 * MARGIN) / CHAR_W);
const CELL_MAX = 40;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return s.replace(/\s+/g, " ");
}

function latin1(s: string): string {
  return [...s].map((ch) => (ch.charCodeAt(0) < 256 ? ch : "?")).join("");
}

function escapePdf(s: string): string {
  return latin1(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** The lines of text a table becomes, laid out in monospace. */
export function tableLines(rows: Row[], title?: string): string[] {
  const lines: string[] = [];
  if (title) lines.push(title, "");
  if (rows.length === 0) {
    lines.push("(no rows)");
    return lines;
  }
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((c) => Math.min(CELL_MAX, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const fit = (s: string, w: number): string => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
  const line = (parts: string[]): string => parts.join("  ").slice(0, COLS_PER_LINE);
  lines.push(line(columns.map((c, i) => fit(c, widths[i]!))));
  lines.push(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) lines.push(line(columns.map((c, i) => fit(cell(row[c]), widths[i]!))));
  return lines;
}

/** The bytes of a PDF holding these lines, paged. */
export function toPdf(rows: Row[], title?: string): Buffer {
  const lines = tableLines(rows, title);
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  // Objects: 1 catalog, 2 pages, 3 font, then a page and a stream per sheet.
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // the page tree, filled in once the page ids are known
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  pages.forEach((sheet, index) => {
    const text = [
      "BT",
      `/F1 ${FONT_PT} Tf`,
      `${LEAD} TL`,
      `${MARGIN} ${PAGE_H - MARGIN} Td`,
      ...sheet.map((l) => `(${escapePdf(l)}) Tj T*`),
      "ET",
      "BT",
      `/F1 ${FONT_PT} Tf`,
      `${PAGE_W / 2 - 10} ${MARGIN / 2} Td`,
      `(${index + 1} / ${pages.length}) Tj`,
      "ET",
    ].join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`);
    const page = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`,
    );
    pageIds.push(page);
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
