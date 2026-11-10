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
/** One bar's row, when the bars run across, and the least a row may shrink to under a height. */
const ROW = 26;
const MIN_ROW = 16;
/** Bars run across only for categories; more than this is a series, which keeps its columns. */
const MAX_ROWS = 16;
/** About how wide a character draws at the chart's 11 px, for a chart not laid out. */
const CHAR_PX = 6.2;

function svg(el: Element, width: number, height: number): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${width} ${height}`);
  s.setAttribute("class", "kos-chart");
  // Its geometry runs left to right, whatever the page's direction.
  s.setAttribute("style", "direction:ltr");
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

/** How wide each label draws in this chart: all placed, then read in one pass, so the page lays out once. */
function widths(s: SVGSVGElement, labels: string[]): number[] {
  const texts = labels.map((l) => add(s, "text", {}, l) as SVGTextContentElement);
  const out = texts.map(textWidth);
  for (const t of texts) t.remove();
  return out;
}

/** Cut a label of this width to its room with an ellipsis, the whole of it in its title. */
function fit(t: SVGElement, width: number, room: number): void {
  if (width <= room) return;
  const text = t as SVGTextContentElement;
  const whole = text.textContent ?? "";
  const cut = (n: number): string => `${whole.slice(0, n).trimEnd()}…`;
  // The longest start that fits, found by halves: a read for each, not one for each character.
  let lo = 1;
  let hi = whole.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    text.textContent = cut(mid);
    if (textWidth(text) <= room) lo = mid;
    else hi = mid - 1;
  }
  text.textContent = cut(lo);
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

/** Every how many labels has room beside the next, at a step of this many px. */
const thin = (sizes: number[], step: number): number => Math.max(1, Math.ceil((Math.max(0, ...sizes) + LABEL_GAP) / step));

/**
 * Bars side by side while every label fits under its own; past that, as on a
 * phone with a word for each category, one bar a row, its label at its left
 * and its figure at its end, so no label is ever drawn over another. A
 * height too short for rows, or more bars than categories have, keeps the
 * columns and labels as many as have room.
 */
export function bar(el: Element, data: Series): void {
  const w = widthOf(el, 600);
  const labels = data.values.map((_, i) => String(data.labels[i] ?? ""));
  const n = data.values.length || 1;
  const slot = (w - PAD - 4) / n;
  const sizes = widths(svg(el, w, 1), labels);
  const row = Math.min(ROW, data.height ? (data.height - 8) / n : ROW);
  if (thin(sizes, slot) === 1 || n > MAX_ROWS || row < MIN_ROW) return columns(el, data, labels, slot, thin(sizes, slot));
  rows(el, data, labels, sizes, w, row);
}

function columns(el: Element, data: Series, labels: string[], slot: number, every: number): void {
  const { s, h, max } = frame(el, data);
  data.values.forEach((v, i) => {
    const bh = ((h - PAD * 2) * Math.max(0, v)) / max;
    add(s, "rect", { x: PAD + i * slot + slot * 0.15, y: h - PAD - bh, width: slot * 0.7, height: bh, rx: 3, style: "fill:var(--accent)" });
    if (i % every === 0) add(s, "text", { x: PAD + i * slot + slot / 2, y: h - PAD + 14, "text-anchor": "middle" }, labels[i]);
  });
}

function rows(el: Element, data: Series, labels: string[], sizes: number[], w: number, row: number): void {
  const n = data.values.length;
  const h = n * row + 8;
  const s = svg(el, w, h);
  const max = Math.max(0, ...data.values) || 1;
  const figures = data.values.map(short);
  // The labels take what they need, up to two fifths; a longer one is cut to fit.
  const room = Math.min(Math.max(0, ...sizes), w * 0.4);
  const left = room + LABEL_GAP;
  const span = Math.max(1, w - left - Math.max(0, ...widths(s, figures)) - LABEL_GAP);
  add(s, "line", { x1: left, y1: 0, x2: left, y2: h, class: "axis" });
  data.values.forEach((v, i) => {
    const mid = 4 + i * row + row / 2;
    const bw = (span * Math.max(0, v)) / max;
    add(s, "rect", { x: left, y: mid - row * 0.3, width: bw, height: row * 0.6, rx: 3, style: "fill:var(--accent)" });
    fit(add(s, "text", { x: room, y: mid + 4, "text-anchor": "end" }, labels[i]), sizes[i]!, room);
    add(s, "text", { x: left + bw + 6, y: mid + 4 }, figures[i]);
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
  const every = Math.max(Math.ceil(n / 8), thin(widths(s, labels), step));
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

