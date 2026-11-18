import type { DocView } from "@kos/shared";
import { find, kid, kids, parseXml, path, textOf, type XmlNode } from "./xml.js";

/**
 * A Word document as HTML.
 *
 * Read from the document's own XML: paragraphs with their headings, lists,
 * alignment and run formatting, tables with merged cells, and pictures the
 * file carries, inlined. Every word is escaped as it is written, so the
 * output is markup KOS wrote around the document's text, never the
 * document's markup. Left out and said so: pictures linked from elsewhere,
 * which would be a request on opening. Macros are never read; they are a
 * separate part nothing here opens.
 */

type Parts = Map<string, Buffer>;

/** Pictures past this are left out; a page does not need a 20 MB photo inline. */
const PICTURE_MAX = 6 * 1024 * 1024;
/** All the pictures inlined into one document. */
const PICTURES_TOTAL = 24 * 1024 * 1024;
const PICTURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
/** One EMU is 1/914400 inch; at 96 dpi a pixel is 9525. */
const EMU_PER_PX = 9525;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlOf = (parts: Parts, name: string): XmlNode | undefined => {
  const buf = parts.get(name);
  return buf ? parseXml(buf.toString("utf8")) : undefined;
};

interface Rel {
  target: string;
  external: boolean;
}

export function relsOf(parts: Parts, name: string, base: string): Map<string, Rel> {
  const rels = new Map<string, Rel>();
  for (const r of kids(xmlOf(parts, name), "Relationship")) {
    const id = r.attrs.Id;
    const target = r.attrs.Target ?? "";
    if (!id) continue;
    const external = r.attrs.TargetMode === "External";
    rels.set(id, { external, target: external ? target : joinPart(base, target) });
  }
  return rels;
}

/** A part's name from a relationship's target, relative to the folder of the part that names it. */
export function joinPart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out = base ? base.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

/** A picture part as a data URI, within the caps; undefined for a type a browser should not be handed. */
export function pictureUri(parts: Parts, name: string, budget: { left: number }): string | undefined {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const type = PICTURE_TYPES[ext];
  const bytes = parts.get(name);
  if (!type || !bytes || bytes.length > PICTURE_MAX || bytes.length > budget.left) return undefined;
  budget.left -= bytes.length;
  return `data:${type};base64,${bytes.toString("base64")}`;
}

interface ListLevel {
  ordered: boolean;
}

interface Context {
  parts: Parts;
  rels: Map<string, Rel>;
  /** Style id to the tag a paragraph of that style is. */
  styles: Map<string, string>;
  /** numId, then level, to whether the list is numbered. */
  lists: Map<string, Map<number, ListLevel>>;
  budget: { left: number };
  notes: Set<string>;
}

export function docxToView(parts: Parts): DocView {
  const doc = xmlOf(parts, "word/document.xml");
  if (!doc) throw new Error("not a Word document: no word/document.xml inside");
  const ctx: Context = {
    parts,
    rels: relsOf(parts, "word/_rels/document.xml.rels", "word"),
    styles: stylesOf(xmlOf(parts, "word/styles.xml")),
    lists: listsOf(xmlOf(parts, "word/numbering.xml")),
    budget: { left: PICTURES_TOTAL },
    notes: new Set(),
  };
  const body = kid(doc, "w:body");
  const html = blocks(kids(body), ctx);
  return { kind: "doc", format: "docx", html, notes: [...ctx.notes] };
}

/** Heading and quote styles by id, from their names, which Word keeps stable across languages. */
function stylesOf(styles: XmlNode | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of kids(styles, "w:style")) {
    const id = s.attrs["w:styleId"];
    const name = (kid(s, "w:name")?.attrs["w:val"] ?? "").toLowerCase();
    if (!id) continue;
    const heading = /^heading (\d)$/.exec(name);
    if (heading) out.set(id, `h${Math.min(6, Number(heading[1]))}`);
    else if (name === "title") out.set(id, "h1");
    else if (name === "subtitle") out.set(id, "h2");
    else if (name === "quote" || name === "intense quote") out.set(id, "blockquote");
  }
  return out;
}

function listsOf(numbering: XmlNode | undefined): Map<string, Map<number, ListLevel>> {
  const abstract = new Map<string, Map<number, ListLevel>>();
  for (const a of kids(numbering, "w:abstractNum")) {
    const levels = new Map<number, ListLevel>();
    for (const l of kids(a, "w:lvl")) {
      const fmt = kid(l, "w:numFmt")?.attrs["w:val"] ?? "bullet";
      levels.set(Number(l.attrs["w:ilvl"] ?? 0), { ordered: fmt !== "bullet" && fmt !== "none" });
    }
    abstract.set(a.attrs["w:abstractNumId"] ?? "", levels);
  }
  const out = new Map<string, Map<number, ListLevel>>();
  for (const n of kids(numbering, "w:num")) {
    const levels = abstract.get(kid(n, "w:abstractNumId")?.attrs["w:val"] ?? "");
    if (levels) out.set(n.attrs["w:numId"] ?? "", levels);
  }
  return out;
}

interface ListItem {
  /** Which list it is in Word's numbering: a new one at the top level is a new list. */
  numId: string;
  level: number;
  ordered: boolean;
  html: string;
}

/** Body-level content: paragraphs, tables and lists gathered from consecutive numbered paragraphs. */
function blocks(nodes: XmlNode[], ctx: Context): string {
  const out: string[] = [];
  let list: ListItem[] = [];
  const flush = (): void => {
    if (list.length) out.push(nestList(list));
    list = [];
  };
  for (const node of flatten(nodes)) {
    if (node.name === "w:p") {
      const num = path(node, "w:pPr", "w:numPr");
      const numId = kid(num, "w:numId")?.attrs["w:val"];
      if (num && numId && numId !== "0") {
        const level = Number(kid(num, "w:ilvl")?.attrs["w:val"] ?? 0);
        if (level === 0 && list.length && list[0]!.numId !== numId) flush();
        list.push({ numId, level, ordered: ctx.lists.get(numId)?.get(level)?.ordered ?? false, html: inline(node, ctx) });
        continue;
      }
      flush();
      out.push(paragraph(node, ctx));
    } else if (node.name === "w:tbl") {
      flush();
      out.push(table(node, ctx));
    }
  }
  flush();
  return out.join("\n");
}

/** Content controls and tracked insertions hold body content; they are opened, not shown as themselves. */
function flatten(nodes: XmlNode[]): XmlNode[] {
  return nodes.flatMap((n) => (n.name === "w:sdt" ? flatten(kids(kid(n, "w:sdtContent"))) : n.name === "w:customXml" || n.name === "w:ins" ? flatten(kids(n)) : [n]));
}

function nestList(items: ListItem[]): string {
  let html = "";
  const open: ListItem[] = [];
  for (const item of items) {
    while (open.length && open[open.length - 1]!.level > item.level) html += `</li></${open.pop()!.ordered ? "ol" : "ul"}>`;
    const top = open[open.length - 1];
    if (!top || top.level < item.level) {
      html += `<${item.ordered ? "ol" : "ul"}><li>`;
      open.push(item);
    } else html += "</li><li>";
    html += item.html;
  }
  while (open.length) html += `</li></${open.pop()!.ordered ? "ol" : "ul"}>`;
  return html;
}

function paragraph(p: XmlNode, ctx: Context): string {
  const pPr = kid(p, "w:pPr");
  const styleId = kid(pPr, "w:pStyle")?.attrs["w:val"] ?? "";
  const tag = ctx.styles.get(styleId) ?? (/^heading(\d)$/i.exec(styleId) ? `h${Math.min(6, Number(/\d/.exec(styleId)![0]))}` : "p");
  const style = paragraphStyle(pPr);
  const content = inline(p, ctx);
  // An empty paragraph is a blank line in Word; it keeps its height here too.
  return `<${tag}${style ? ` style="${style}"` : ""}>${content || "<br>"}</${tag}>`;
}

function paragraphStyle(pPr: XmlNode | undefined): string {
  const css: string[] = [];
  const jc = kid(pPr, "w:jc")?.attrs["w:val"];
  if (jc === "center") css.push("text-align:center");
  else if (jc === "right" || jc === "end") css.push("text-align:right");
  else if (jc === "both" || jc === "distribute") css.push("text-align:justify");
  const ind = kid(pPr, "w:ind");
  const left = Number(ind?.attrs["w:left"] ?? ind?.attrs["w:start"] ?? 0);
  // Twentieths of a point; a pixel is three quarters of one.
  if (left > 0) css.push(`margin-left:${Math.round(left / 15)}px`);
  return css.join(";");
}

/** A paragraph's runs, links and pictures, as inline HTML. */
function inline(node: XmlNode, ctx: Context): string {
  let html = "";
  for (const c of kids(node)) {
    if (c.name === "w:r") html += run(c, ctx);
    else if (c.name === "w:hyperlink") {
      // Its words, marked as a link, going nowhere: a viewer opens nothing on a click.
      const inner = inline(c, ctx);
      const rel = c.attrs["r:id"] ? ctx.rels.get(c.attrs["r:id"]) : undefined;
      html += `<span class="link"${rel?.external ? ` title="${esc(rel.target.slice(0, 300))}"` : ""}>${inner}</span>`;
    } else if (c.name === "w:smartTag" || c.name === "w:ins" || c.name === "w:customXml" || c.name === "w:fldSimple" || c.name === "w:sdt" || c.name === "w:sdtContent") html += inline(c, ctx);
  }
  return html;
}

function run(r: XmlNode, ctx: Context): string {
  let text = "";
  for (const c of kids(r)) {
    if (c.name === "w:t") text += esc(textOf(c));
    else if (c.name === "w:tab") text += '<span class="tab"></span>';
    else if (c.name === "w:br" || c.name === "w:cr") text += c.attrs["w:type"] === "page" ? "" : "<br>";
    else if (c.name === "w:noBreakHyphen") text += "&#8209;";
    else if (c.name === "w:drawing" || c.name === "w:pict") text += pictures(c, ctx);
  }
  if (!text) return "";
  const rPr = kid(r, "w:rPr");
  if (!rPr) return text;
  const on = (name: string): boolean => {
    const el = kid(rPr, name);
    return !!el && el.attrs["w:val"] !== "0" && el.attrs["w:val"] !== "false" && el.attrs["w:val"] !== "none";
  };
  const css: string[] = [];
  const color = kid(rPr, "w:color")?.attrs["w:val"];
  if (color && /^[0-9A-Fa-f]{6}$/.test(color) && color !== "000000") css.push(`color:#${color}`);
  const size = Number(kid(rPr, "w:sz")?.attrs["w:val"] ?? 0);
  if (size > 0 && size !== 22 && size !== 24) css.push(`font-size:${(size / 2).toFixed(1)}pt`);
  const font = kid(rPr, "w:rFonts")?.attrs["w:ascii"] ?? kid(rPr, "w:rFonts")?.attrs["w:hAnsi"];
  if (font && /^[\w -]{1,40}$/.test(font)) css.push(`font-family:'${font}'`);
  const highlight = kid(rPr, "w:highlight")?.attrs["w:val"];
  if (highlight && /^[a-zA-Z]+$/.test(highlight) && highlight !== "none") css.push(`background-color:${highlight.toLowerCase()}`);
  if (on("w:caps")) css.push("text-transform:uppercase");
  if (on("w:smallCaps")) css.push("font-variant:small-caps");
  let out = css.length ? `<span style="${css.join(";")}">${text}</span>` : text;
  if (on("w:b")) out = `<strong>${out}</strong>`;
  if (on("w:i")) out = `<em>${out}</em>`;
  if (on("w:u")) out = `<u>${out}</u>`;
  if (on("w:strike") || on("w:dstrike")) out = `<s>${out}</s>`;
  const va = kid(rPr, "w:vertAlign")?.attrs["w:val"];
  if (va === "superscript") out = `<sup>${out}</sup>`;
  else if (va === "subscript") out = `<sub>${out}</sub>`;
  return out;
}

/** The pictures in a drawing, inline at their size, or nothing for one the file only links to. */
function pictures(drawing: XmlNode, ctx: Context): string {
  let html = "";
  for (const blip of [...find(drawing, "a:blip"), ...find(drawing, "v:imagedata")]) {
    const id = blip.attrs["r:embed"] ?? blip.attrs["r:id"] ?? blip.attrs["r:link"];
    const rel = id ? ctx.rels.get(id) : undefined;
    if (!rel) continue;
    if (rel.external || blip.attrs["r:link"]) {
      ctx.notes.add("Pictures linked from outside the document are not loaded.");
      continue;
    }
    const src = pictureUri(ctx.parts, rel.target, ctx.budget);
    if (!src) {
      ctx.notes.add("Some pictures are left out: too large, or a kind a browser does not draw.");
      continue;
    }
    const extent = find(drawing, "wp:extent")[0];
    const width = Math.round(Number(extent?.attrs.cx ?? 0) / EMU_PER_PX);
    html += `<img src="${src}" alt=""${width > 0 ? ` width="${Math.min(width, 2000)}"` : ""}>`;
  }
  return html;
}

function table(tbl: XmlNode, ctx: Context): string {
  const rows = kids(tbl, "w:tr");
  /** Cells continuing a vertical merge from above: left out, the first one spans them. */
  const grid = rows.map((tr) =>
    kids(tr, "w:tc").map((tc) => {
      const pr = kid(tc, "w:tcPr");
      const merge = kid(pr, "w:vMerge");
      return { tc, span: Number(kid(pr, "w:gridSpan")?.attrs["w:val"] ?? 1), merge: merge ? (merge.attrs["w:val"] === "restart" ? "start" : "continue") : undefined };
    }),
  );
  const columnOf = (row: typeof grid[number], index: number): number => row.slice(0, index).reduce((n, c) => n + c.span, 0);
  const html = grid.map((row, r) => {
    const cells = row.map((cell, i) => {
      if (cell.merge === "continue") return "";
      let rowspan = 1;
      if (cell.merge === "start") {
        const col = columnOf(row, i);
        for (let below = r + 1; below < grid.length; below++) {
          const under = grid[below]!.find((c, j) => columnOf(grid[below]!, j) === col);
          if (under?.merge !== "continue") break;
          rowspan++;
        }
      }
      const attrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}`;
      return `<td${attrs}>${blocks(kids(cell.tc), ctx)}</td>`;
    });
    return `<tr>${cells.join("")}</tr>`;
  });
  return `<table>${html.join("")}</table>`;
}
