/**
 * Small charts for an HTML page, drawn as SVG in KOS's theme: a page has no
 * network, so it cannot fetch a charting library, and most pages need a bar,
 * a line or a share of a whole and nothing more.
 */

export interface Series {
  labels: (string | number)[];
  values: number[];
  /** Height in px; the width follows the element. */
  height?: number;
}

const NS = "http://www.w3.org/2000/svg";
const TONES = ["--accent", "--ok", "--warn", "--violet", "--danger", "--muted"];
/** The room under the plot for the labels, and left of it for the figures. */
const PAD = 28;
/** The space a label keeps from the next, and from its bar. */
const LABEL_GAP = 8;
/** One bar's row, when the bars run across. */
const ROW = 26;
/** About how wide a character draws at the chart's 11 px, for a chart not laid out. */
const CHAR_PX = 6.2;

function svg(el: Element, width: number, height: number): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${width} ${height}`);
  s.setAttribute("class", "kos-chart");
  el.replaceChildren(s);
  return s;
}

function add(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function short(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

function widthOf(el: Element, fallback: number): number {
  return Math.max(240, Math.round(el.getBoundingClientRect().width) || fallback);
}

/** How wide a label draws: as laid out, or by its length where nothing is laid out yet. */
function textWidth(t: SVGTextContentElement): number {
  return t.getComputedTextLength?.() || (t.textContent ?? "").length * CHAR_PX;
}

/** The widest of these labels as the chart draws them, measured in a chart of its own when none is given. */
function widest(el: Element, labels: string[], into?: SVGSVGElement): number {
  const s = into ?? svg(el, 1, 1);
  const widths = labels.map((l) => {
    const t = add(s, "text", {}, l) as SVGTextContentElement;
    const width = textWidth(t);
    t.remove();
    return width;
  });
  return Math.max(0, ...widths);
}

/** Cut a label to its room with an ellipsis, the whole of it in its title. */
function fit(t: SVGElement, room: number): void {
  const text = t as SVGTextContentElement;
  const whole = text.textContent ?? "";
  if (textWidth(text) <= room) return;
  let cut = whole;
  while (cut.length > 1 && textWidth(text) > room) text.textContent = `${(cut = cut.slice(0, -1)).trimEnd()}\u2026`;
  add(text, "title", {}, whole);
}

function frame(el: Element, data: Series): { s: SVGSVGElement; w: number; h: number; max: number } {
  const w = widthOf(el, 600);
  const h = data.height ?? 220;
  const s = svg(el, w, h);
  const max = Math.max(0, ...data.values) || 1;
  add(s, "line", { x1: PAD, y1: h - PAD, x2: w - 4, y2: h - PAD, class: "axis" });
  add(s, "text", { x: 0, y: 12 }, short(max));
  return { s, w, h, max };
}

/**
 * Bars side by side while every label fits under its own; past that, as on a
 * phone with a word for each category, one bar a row, its label at its left
 * and its figure at its end, so no label is ever drawn over another.
 */
export function bar(el: Element, data: Series): void {
  const w = widthOf(el, 600);
  const labels = data.values.map((_, i) => String(data.labels[i] ?? ""));
  const n = data.values.length || 1;
  const slot = (w - PAD - 4) / n;
  if (n > 16 || widest(el, labels) + LABEL_GAP <= slot) return columns(el, data, labels, slot);
  rows(el, data, labels, w);
}

function columns(el: Element, data: Series, labels: string[], slot: number): void {
  const { s, h, max } = frame(el, data);
  const n = data.values.length;
  data.values.forEach((v, i) => {
    const bh = ((h - PAD * 2) * Math.max(0, v)) / max;
    add(s, "rect", { x: PAD + i * slot + slot * 0.15, y: h - PAD - bh, width: slot * 0.7, height: bh, rx: 3, style: "fill:var(--accent)" });
    if (n <= 16) add(s, "text", { x: PAD + i * slot + slot / 2, y: h - PAD + 14, "text-anchor": "middle" }, labels[i]);
  });
}

function rows(el: Element, data: Series, labels: string[], w: number): void {
  const n = data.values.length;
  const h = n * ROW + 8;
  const s = svg(el, w, h);
  const max = Math.max(0, ...data.values) || 1;
  // The labels take what they need, up to two fifths; a longer one is cut to fit.
  const room = Math.min(widest(el, labels, s), w * 0.4);
  const left = room + LABEL_GAP;
  const figure = widest(el, data.values.map(short), s) + LABEL_GAP;
  const span = Math.max(1, w - left - figure);
  add(s, "line", { x1: left, y1: 0, x2: left, y2: h, class: "axis" });
  data.values.forEach((v, i) => {
    const mid = 4 + i * ROW + ROW / 2;
    const bw = (span * Math.max(0, v)) / max;
    add(s, "rect", { x: left, y: mid - ROW * 0.3, width: bw, height: ROW * 0.6, rx: 3, style: "fill:var(--accent)" });
    fit(add(s, "text", { x: room, y: mid + 4, "text-anchor": "end" }, labels[i]), room);
    add(s, "text", { x: left + bw + 6, y: mid + 4 }, short(v));
  });
}

/** A label under every point that has room for it, at most eight. */
export function line(el: Element, data: Series): void {
  const labels = data.labels.map(String);
  const { s, w, h, max } = frame(el, data);
  const n = data.values.length;
  const step = n <= 1 ? w : (w - PAD - 8) / (n - 1);
  const x = (i: number): number => PAD + (n <= 1 ? 0 : i * step);
  const y = (v: number): number => h - PAD - ((h - PAD * 2) * v) / max;
  const points = data.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  add(s, "polyline", { points, fill: "none", style: "stroke:var(--accent);stroke-width:2" });
  const every = Math.max(1, Math.ceil(n / 8), Math.ceil((widest(el, labels, s) + LABEL_GAP) / step));
  labels.forEach((l, i) => {
    if (i % every === 0) add(s, "text", { x: x(i), y: h - PAD + 14, "text-anchor": "middle" }, l);
  });
}

export function pie(el: Element, data: Series): void {
  const h = data.height ?? 220;
  const w = widthOf(el, 480);
  const s = svg(el, w, h);
  const total = data.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const r = h / 2 - 8;
  const cx = r + 8;
  let angle = -Math.PI / 2;
  data.values.forEach((v, i) => {
    const share = Math.max(0, v) / total;
    const next = angle + share * Math.PI * 2;
    const large = share > 0.5 ? 1 : 0;
    const d = `M${cx},${h / 2} L${cx + r * Math.cos(angle)},${h / 2 + r * Math.sin(angle)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(next)},${h / 2 + r * Math.sin(next)} Z`;
    const tone = `var(${TONES[i % TONES.length]})`;
    add(s, "path", { d, style: `fill:${tone}` });
    add(s, "rect", { x: cx + r + 20, y: 12 + i * 18, width: 10, height: 10, rx: 2, style: `fill:${tone}` });
    add(s, "text", { x: cx + r + 36, y: 21 + i * 18 }, `${String(data.labels[i] ?? "")} · ${Math.round(share * 100)}%`);
    angle = next;
  });
}

