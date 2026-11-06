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

function frame(el: Element, data: Series): { s: SVGSVGElement; w: number; h: number; max: number; pad: number } {
  const w = Math.max(240, Math.round(el.getBoundingClientRect().width) || 600);
  const h = data.height ?? 220;
  const s = svg(el, w, h);
  const max = Math.max(0, ...data.values) || 1;
  const pad = 28;
  add(s, "line", { x1: pad, y1: h - pad, x2: w - 4, y2: h - pad, class: "axis" });
  add(s, "text", { x: 0, y: 12 }, short(max));
  return { s, w, h, max, pad };
}

export function bar(el: Element, data: Series): void {
  const { s, w, h, max, pad } = frame(el, data);
  const n = data.values.length || 1;
  const slot = (w - pad - 4) / n;
  data.values.forEach((v, i) => {
    const bh = ((h - pad * 2) * Math.max(0, v)) / max;
    add(s, "rect", { x: pad + i * slot + slot * 0.15, y: h - pad - bh, width: slot * 0.7, height: bh, rx: 3, style: "fill:var(--accent)" });
    if (n <= 16) add(s, "text", { x: pad + i * slot + slot / 2, y: h - pad + 14, "text-anchor": "middle" }, String(data.labels[i] ?? ""));
  });
}

export function line(el: Element, data: Series): void {
  const { s, w, h, max, pad } = frame(el, data);
  const n = data.values.length;
  const x = (i: number): number => pad + (n <= 1 ? 0 : (i * (w - pad - 8)) / (n - 1));
  const y = (v: number): number => h - pad - ((h - pad * 2) * v) / max;
  const points = data.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  add(s, "polyline", { points, fill: "none", style: "stroke:var(--accent);stroke-width:2" });
  const every = Math.max(1, Math.ceil(n / 8));
  data.labels.forEach((l, i) => {
    if (i % every === 0) add(s, "text", { x: x(i), y: h - pad + 14, "text-anchor": "middle" }, String(l));
  });
}

export function pie(el: Element, data: Series): void {
  const h = data.height ?? 220;
  const w = Math.max(240, Math.round(el.getBoundingClientRect().width) || 480);
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

