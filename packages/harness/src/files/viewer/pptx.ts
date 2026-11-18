import { joinPart, pictureUri, relsOf } from "./docx.js";
import type { SlideFrame as Frame, SlideParagraph as Paragraph, SlideRun as Run, SlideShape as Shape, Slide, SlidesView } from "@kos/shared";
import { find, kid, kids, parseXml, path, textOf, type XmlNode } from "./xml.js";

/**
 * A PowerPoint deck as slides KOS draws itself.
 *
 * Each slide is read from its XML with what it inherits from its layout and
 * master (where a placeholder sits, the size of its words, the background,
 * the master's own pictures and shapes), and kept as positioned text,
 * pictures, boxes and tables. That is most of what a deck is, drawn at any
 * size, with no converter to install and nothing that runs. What is left
 * out is said: charts, SmartArt, video, and pictures of a kind a browser
 * does not draw (EMF, WMF).
 */

type Parts = Map<string, Buffer>;

/** Decks past this many slides show the first ones. */
export const SLIDES_MAX = 200;
/** All the pictures inlined into one deck. */
const PICTURES_TOTAL = 48 * 1024 * 1024;
const EMU_PER_POINT = 12700;

const xmlOf = (parts: Parts, name: string): XmlNode | undefined => {
  const buf = parts.get(name);
  return buf ? parseXml(buf.toString("utf8")) : undefined;
};
const dirOf = (name: string): string => name.slice(0, Math.max(0, name.lastIndexOf("/")));
const relsName = (name: string): string => `${dirOf(name)}/_rels/${name.split("/").pop()}.rels`;

/** A part and the parts it names, opened once. */
interface Part {
  name: string;
  xml: XmlNode;
  rels: Map<string, { target: string; external: boolean }>;
}

function open(parts: Parts, name: string): Part | undefined {
  const xml = xmlOf(parts, name);
  return xml ? { name, xml, rels: relsOf(parts, relsName(name), dirOf(name)) } : undefined;
}

/** The part a relationship of this type names: a slide's layout, a layout's master. */
function related(parts: Parts, from: Part | undefined, type: string): Part | undefined {
  if (!from) return undefined;
  const rels = kids(xmlOf(parts, relsName(from.name)), "Relationship");
  const rel = rels.find((r) => (r.attrs.Type ?? "").endsWith(`/${type}`));
  return rel ? open(parts, joinPart(dirOf(from.name), rel.attrs.Target ?? "")) : undefined;
}

interface Deck {
  parts: Parts;
  cx: number;
  cy: number;
  scheme: Map<string, string>;
  budget: { left: number };
  notes: Set<string>;
}

export function pptxToView(parts: Parts): SlidesView {
  const presentation = open(parts, "ppt/presentation.xml");
  if (!presentation) throw new Error("not a PowerPoint deck: no ppt/presentation.xml inside");
  const size = path(presentation.xml, "p:sldSz");
  const cx = Number(size?.attrs.cx ?? 9144000) || 9144000;
  const cy = Number(size?.attrs.cy ?? 6858000) || 6858000;
  const ids = kids(path(presentation.xml, "p:sldIdLst"), "p:sldId");
  const deck: Deck = { parts, cx, cy, scheme: new Map(), budget: { left: PICTURES_TOTAL }, notes: new Set() };
  const slides: Slide[] = [];
  for (const id of ids.slice(0, SLIDES_MAX)) {
    const rel = presentation.rels.get(id.attrs["r:id"] ?? "");
    const slide = rel && !rel.external ? open(parts, rel.target) : undefined;
    if (slide) slides.push(readSlide(deck, slide));
  }
  if (ids.length > SLIDES_MAX) deck.notes.add(`Showing the first ${SLIDES_MAX} of ${ids.length} slides.`);
  return { kind: "slides", format: "pptx", aspect: cx / cy, slides, notes: [...deck.notes] };
}

function readSlide(deck: Deck, slide: Part): Slide {
  const layout = related(deck.parts, slide, "slideLayout");
  const master = related(deck.parts, layout, "slideMaster");
  deck.scheme = schemeOf(xmlOf(deck.parts, related(deck.parts, master, "theme")?.name ?? ""));
  const chain = { slide, layout, master };
  const shapes: Shape[] = [];
  const background = backgroundOf(deck, [slide, layout, master], shapes);
  // The master's and the layout's own pictures and shapes sit under the slide's, unless the slide hides them.
  const showMaster = slide.xml.attrs.showMasterSp !== "0";
  if (showMaster && master && layout?.xml.attrs.showMasterSp !== "0") shapes.push(...tree(deck, master, path(master.xml, "p:cSld", "p:spTree"), chain, false));
  if (showMaster && layout) shapes.push(...tree(deck, layout, path(layout.xml, "p:cSld", "p:spTree"), chain, false));
  shapes.push(...tree(deck, slide, path(slide.xml, "p:cSld", "p:spTree"), chain, true));
  const title = find(path(slide.xml, "p:cSld", "p:spTree"), "p:sp")
    .filter((sp) => /title/i.test(placeholder(sp)?.type ?? ""))
    .map((sp) => textOf(path(sp, "p:txBody")).trim())[0] ?? "";
  const notes = notesOf(deck, slide);
  return { title, shapes, ...(background ? { background } : {}), ...(notes ? { notes } : {}) };
}

interface Chain {
  slide: Part;
  layout?: Part;
  master?: Part;
}

/** A shape tree's shapes: on the slide all of them; on a layout or master only what is not a placeholder. */
function tree(deck: Deck, part: Part, spTree: XmlNode | undefined, chain: Chain, own: boolean, map = (f: Frame): Frame => f): Shape[] {
  const out: Shape[] = [];
  for (const node of kids(spTree)) {
    if (node.name === "p:sp") {
      if (!own && placeholder(node)) continue;
      const shape = textShape(deck, node, chain, own, map);
      if (shape) out.push(shape);
    } else if (node.name === "p:pic") {
      const frame = frameOf(deck, path(node, "p:spPr", "a:xfrm"));
      const src = frame && blipSrc(deck, part, path(node, "p:blipFill", "a:blip"));
      if (frame && src) out.push({ kind: "picture", ...map(frame), src });
    } else if (node.name === "p:grpSp") {
      const xfrm = path(node, "p:grpSpPr", "a:xfrm");
      const off = kid(xfrm, "a:off");
      const ext = kid(xfrm, "a:ext");
      const chOff = kid(xfrm, "a:chOff");
      const chExt = kid(xfrm, "a:chExt");
      const sx = Number(ext?.attrs.cx ?? 1) / (Number(chExt?.attrs.cx ?? 1) || 1);
      const sy = Number(ext?.attrs.cy ?? 1) / (Number(chExt?.attrs.cy ?? 1) || 1);
      const ox = Number(off?.attrs.x ?? 0) / deck.cx;
      const oy = Number(off?.attrs.y ?? 0) / deck.cy;
      const cox = Number(chOff?.attrs.x ?? 0) / deck.cx;
      const coy = Number(chOff?.attrs.y ?? 0) / deck.cy;
      const inner = (f: Frame): Frame => map({ x: ox + (f.x - cox) * sx, y: oy + (f.y - coy) * sy, w: f.w * sx, h: f.h * sy });
      out.push(...tree(deck, part, node, chain, own, inner));
    } else if (node.name === "p:graphicFrame") {
      const frame = frameOf(deck, kid(node, "p:xfrm"));
      const tbl = find(node, "a:tbl")[0];
      if (frame && tbl) out.push({ kind: "table", ...map(frame), rows: kids(tbl, "a:tr").map((tr) => kids(tr, "a:tc").map((tc) => textOf(kid(tc, "a:txBody")).trim())) });
      else if (find(node, "c:chart").length) deck.notes.add("Charts are not drawn here; download the deck to see them.");
      else deck.notes.add("Some objects (SmartArt, video or embedded files) are not drawn here.");
    }
  }
  return out;
}

interface Placeholder {
  type: string;
  idx?: string;
}

function placeholder(sp: XmlNode): Placeholder | undefined {
  const ph = path(sp, "p:nvSpPr", "p:nvPr", "p:ph");
  if (!ph) return undefined;
  return { type: ph.attrs.type ?? "body", ...(ph.attrs.idx !== undefined ? { idx: ph.attrs.idx } : {}) };
}

/** The same placeholder on a layout or master: by its index, else by its kind. */
function inherited(part: Part | undefined, ph: Placeholder): XmlNode | undefined {
  if (!part) return undefined;
  const all = find(path(part.xml, "p:cSld", "p:spTree"), "p:sp").map((sp) => ({ sp, ph: placeholder(sp) })).filter((x) => x.ph);
  const kind = (t: string): string => (t === "ctrTitle" ? "title" : t === "subTitle" || t === "obj" ? "body" : t);
  return (ph.idx !== undefined ? all.find((x) => x.ph!.idx === ph.idx) : undefined)?.sp ?? all.find((x) => kind(x.ph!.type) === kind(ph.type))?.sp;
}

function frameOf(deck: Deck, xfrm: XmlNode | undefined): Frame | undefined {
  const off = kid(xfrm, "a:off");
  const ext = kid(xfrm, "a:ext");
  if (!off || !ext) return undefined;
  return { x: Number(off.attrs.x ?? 0) / deck.cx, y: Number(off.attrs.y ?? 0) / deck.cy, w: Number(ext.attrs.cx ?? 0) / deck.cx, h: Number(ext.attrs.cy ?? 0) / deck.cy };
}

function textShape(deck: Deck, sp: XmlNode, chain: Chain, own: boolean, map: (f: Frame) => Frame): Shape | undefined {
  const ph = own ? placeholder(sp) : undefined;
  const fromLayout = ph ? inherited(chain.layout, ph) : undefined;
  const fromMaster = ph ? inherited(chain.master, ph) : undefined;
  const frame = frameOf(deck, path(sp, "p:spPr", "a:xfrm")) ?? frameOf(deck, path(fromLayout, "p:spPr", "a:xfrm")) ?? frameOf(deck, path(fromMaster, "p:spPr", "a:xfrm"));
  if (!frame) return undefined;
  const fill = fillOf(deck, sp);
  const line = lineOf(deck, sp);
  const body = kid(sp, "p:txBody");
  const paragraphs = body ? paragraphsOf(deck, body, ph, chain, [fromLayout, fromMaster]) : [];
  if (!paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) {
    if (!fill && !line) return undefined;
    const geom = path(sp, "p:spPr", "a:prstGeom")?.attrs.prst ?? "rect";
    return { kind: "box", ...map(frame), ...(fill ? { fill } : {}), ...(line ? { line } : {}), ...(geom === "ellipse" || geom === "roundRect" ? { round: true } : {}) };
  }
  const anchor = [body, fromLayout && kid(fromLayout, "p:txBody"), fromMaster && kid(fromMaster, "p:txBody")]
    .map((b) => kid(b, "a:bodyPr")?.attrs.anchor)
    .find((a) => a !== undefined);
  return {
    kind: "text",
    ...map(frame),
    paragraphs,
    ...(fill ? { fill } : {}),
    ...(line ? { line } : {}),
    ...(anchor === "ctr" ? { anchor: "middle" as const } : anchor === "b" ? { anchor: "bottom" as const } : {}),
  };
}

function paragraphsOf(deck: Deck, body: XmlNode, ph: Placeholder | undefined, chain: Chain, above: (XmlNode | undefined)[]): Paragraph[] {
  const isTitle = /title/i.test(ph?.type ?? "");
  const isBody = !!ph && !isTitle && ph.type !== "dt" && ph.type !== "ftr" && ph.type !== "sldNum";
  const styles = path(chain.master?.xml, "p:txStyles", isTitle ? "p:titleStyle" : isBody ? "p:bodyStyle" : "p:otherStyle");
  const scale = Number(path(body, "a:bodyPr", "a:normAutofit")?.attrs.fontScale ?? 100000) / 100000;
  const out: Paragraph[] = [];
  for (const p of kids(body, "a:p")) {
    const pPr = kid(p, "a:pPr");
    const level = Number(pPr?.attrs.lvl ?? 0);
    const lvl = `a:lvl${level + 1}pPr`;
    // What the placeholder's own list style, its layout's and its master's say, nearest first.
    const levelStyles = [kid(kid(body, "a:lstStyle"), lvl), ...above.map((sp) => kid(kid(kid(sp, "p:txBody"), "a:lstStyle"), lvl)), kid(styles, lvl)];
    const defSize = levelStyles.map((s) => kid(s, "a:defRPr")?.attrs.sz).find((s) => s !== undefined);
    const algn = pPr?.attrs.algn ?? levelStyles.map((s) => s?.attrs.algn).find((a) => a !== undefined);
    const runs: Run[] = [];
    for (const r of kids(p)) {
      if (r.name === "a:br") runs.push({ text: "\n" });
      if (r.name !== "a:r" && r.name !== "a:fld") continue;
      const rPr = kid(r, "a:rPr");
      const sz = Number(rPr?.attrs.sz ?? defSize ?? (isTitle ? 4400 : 1800));
      const color = colorOf(deck, kid(rPr, "a:solidFill")) ?? levelStyles.map((s) => colorOf(deck, kid(kid(s, "a:defRPr"), "a:solidFill"))).find(Boolean);
      runs.push({
        text: textOf(kid(r, "a:t")),
        size: (sz / 100) * scale * EMU_PER_POINT / deck.cx,
        ...(rPr?.attrs.b === "1" ? { bold: true } : {}),
        ...(rPr?.attrs.i === "1" ? { italic: true } : {}),
        ...(rPr?.attrs.u && rPr.attrs.u !== "none" ? { underline: true } : {}),
        ...(color ? { color } : {}),
      });
    }
    const explicitBullet = !!(kid(pPr, "a:buChar") || kid(pPr, "a:buAutoNum"));
    const bullet = !kid(pPr, "a:buNone") && (explicitBullet || (isBody && ph?.type === "body" && runs.some((r) => r.text.trim())));
    out.push({
      runs,
      ...(algn === "ctr" ? { align: "center" as const } : algn === "r" ? { align: "right" as const } : algn === "just" ? { align: "justify" as const } : {}),
      ...(level ? { level } : {}),
      ...(bullet ? { bullet: true } : {}),
    });
  }
  return out;
}

function backgroundOf(deck: Deck, chain: (Part | undefined)[], shapes: Shape[]): string | undefined {
  for (const part of chain) {
    const bg = path(part?.xml, "p:cSld", "p:bg");
    if (!bg || !part) continue;
    const pr = kid(bg, "p:bgPr");
    const blip = path(pr, "a:blipFill", "a:blip");
    if (blip) {
      const src = blipSrc(deck, part, blip);
      if (src) shapes.push({ kind: "picture", x: 0, y: 0, w: 1, h: 1, src });
      return undefined;
    }
    const gradient = path(pr, "a:gradFill", "a:gsLst");
    if (gradient) return colorOf(deck, kids(gradient, "a:gs")[0]);
    return colorOf(deck, kid(pr, "a:solidFill")) ?? colorOf(deck, kid(bg, "p:bgRef"));
  }
  return undefined;
}

function blipSrc(deck: Deck, part: Part, blip: XmlNode | undefined): string | undefined {
  const id = blip?.attrs["r:embed"];
  const rel = id ? part.rels.get(id) : undefined;
  if (blip?.attrs["r:link"] || rel?.external) {
    deck.notes.add("Pictures linked from outside the deck are not loaded.");
    return undefined;
  }
  if (!rel) return undefined;
  const src = pictureUri(deck.parts, rel.target, deck.budget);
  if (!src) deck.notes.add("Some pictures are left out: too large, or a kind a browser does not draw (EMF, WMF).");
  return src;
}

function fillOf(deck: Deck, sp: XmlNode): string | undefined {
  const spPr = kid(sp, "p:spPr");
  if (kid(spPr, "a:noFill")) return undefined;
  return colorOf(deck, kid(spPr, "a:solidFill")) ?? (kid(spPr, "a:gradFill") ? colorOf(deck, kids(path(spPr, "a:gradFill", "a:gsLst"), "a:gs")[0]) : undefined) ?? styleRef(deck, sp, "a:fillRef");
}

function lineOf(deck: Deck, sp: XmlNode): string | undefined {
  const ln = path(sp, "p:spPr", "a:ln");
  if (kid(ln, "a:noFill")) return undefined;
  return colorOf(deck, kid(ln, "a:solidFill")) ?? styleRef(deck, sp, "a:lnRef");
}

/** A shape's theme style, as an auto shape is drawn: its colour where its index asks for one. */
function styleRef(deck: Deck, sp: XmlNode, ref: string): string | undefined {
  const node = path(sp, "p:style", ref);
  return node && Number(node.attrs.idx ?? 0) > 0 ? colorOf(deck, node) : undefined;
}

function notesOf(deck: Deck, slide: Part): string | undefined {
  const notes = related(deck.parts, slide, "notesSlide");
  const body = find(path(notes?.xml, "p:cSld", "p:spTree"), "p:sp").find((sp) => placeholder(sp)?.type === "body");
  const text = kids(path(body, "p:txBody"), "a:p").map((p) => textOf(p).trim()).filter(Boolean).join("\n");
  return text || undefined;
}

/** The theme's colours by name: dk1, lt1, accent1 and the rest. */
function schemeOf(theme: XmlNode | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of kids(find(theme, "a:clrScheme")[0])) {
    const value = kid(c, "a:srgbClr")?.attrs.val ?? kid(c, "a:sysClr")?.attrs.lastClr;
    if (value) out.set(c.name.replace(/^a:/, ""), value);
  }
  return out;
}

const SCHEME_ALIAS: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };

/** A colour element's colour as #rrggbb, with its luminance changes applied; undefined for none. */
function colorOf(deck: Deck, holder: XmlNode | undefined): string | undefined {
  const c = kids(holder).find((k) => ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr"].includes(k.name));
  if (!c) return undefined;
  let hex: string | undefined;
  if (c.name === "a:srgbClr") hex = c.attrs.val;
  else if (c.name === "a:sysClr") hex = c.attrs.lastClr;
  else if (c.name === "a:schemeClr") hex = deck.scheme.get(SCHEME_ALIAS[c.attrs.val ?? ""] ?? c.attrs.val ?? "");
  else hex = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080" }[c.attrs.val ?? ""];
  if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return undefined;
  const mod = (name: string): number | undefined => {
    const v = kid(c, name)?.attrs.val;
    return v === undefined ? undefined : Number(v) / 100000;
  };
  return shade(hex, mod("a:lumMod"), mod("a:lumOff"), mod("a:tint"), mod("a:shade"));
}

/** A colour's lightness moved as DrawingML moves it. */
function shade(hex: string, lumMod = 1, lumOff = 0, tint?: number, shadeBy?: number): string {
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  if (tint !== undefined) [r, g, b] = [r, g, b].map((v) => v + (1 - v) * (1 - tint)) as [number, number, number];
  if (shadeBy !== undefined) [r, g, b] = [r, g, b].map((v) => v * shadeBy) as [number, number, number];
  if (lumMod !== 1 || lumOff !== 0) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    l = Math.min(1, Math.max(0, l * lumMod + lumOff));
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h % 6) + 6) % 2 - 1));
    const m = l - c / 2;
    const seg = Math.floor(((h % 6) + 6) % 6);
    [r, g, b] = ([[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg] ?? [0, 0, 0]).map((v) => v + m) as [number, number, number];
  }
  return `#${[r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}
