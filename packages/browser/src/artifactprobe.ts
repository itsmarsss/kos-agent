/**
 * What artifacts.check measures inside an artifact's frame, once it has
 * settled. It runs in the page's own document (evaluated over CDP in the
 * frame's context) and returns plain data; artifactcheck.ts compares the
 * renders and words the findings.
 *
 * Kept as one self-contained function, serialised into the frame, so it
 * depends on nothing the page could have replaced after the fact beyond
 * the DOM itself.
 */

/** One element's look, keyed by its place in the document so two renders line up. */
export interface ProbedElement {
  key: string;
  /** A short way to name it: tag#id.class, and a little of its text. */
  name: string;
  color: string;
  background: string;
  /** The colour behind it, from its first painted ancestor; undefined behind an image or gradient. */
  behind?: string;
  /** Contrast of its text against what is behind it, when it holds text. */
  contrast?: number;
  large: boolean;
  hasText: boolean;
}

export interface ProbeResult {
  viewport: { width: number; height: number };
  scrollWidth: number;
  /** Elements reaching past the right edge, outside anything that scrolls or clips them. */
  overflow: { name: string; right: number }[];
  elements: ProbedElement[];
  bodyBackground: string;
  /** Boxes that look like regions (a border or a fill) and hold nothing. */
  empty: { name: string; width: number; height: number }[];
  /** Visible text naming the artifact: an h1, or a deck's first slide heading. */
  title: string | undefined;
  /** Cells or text showing a formula error. */
  formulaErrors: string[];
}

/** The function serialised into the frame; it must not close over anything. */
export function probe(): ProbeResult {
  const view = { width: document.documentElement.clientWidth, height: window.innerHeight };
  const named = (el: Element): string => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const rgba = (c: string): [number, number, number, number] | undefined => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return undefined;
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const over = (top: [number, number, number, number], base: [number, number, number]): [number, number, number] => [
    top[0] * top[3] + base[0] * (1 - top[3]),
    top[1] * top[3] + base[1] * (1 - top[3]),
    top[2] * top[3] + base[2] * (1 - top[3]),
  ];
  const lum = ([r, g, b]: [number, number, number]): number => {
    const f = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // What shows behind an element: its ancestors' fills, painted from the root down.
  const behindOf = (el: Element): [number, number, number] | undefined => {
    const fills: [number, number, number, number][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return undefined;
      const c = rgba(s.backgroundColor);
      if (c && c[3] > 0) {
        fills.push(c);
        if (c[3] >= 1) break;
      }
    }
    let base: [number, number, number] = [255, 255, 255];
    const root = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (!fills.length || (fills.at(-1)?.[3] ?? 0) < 1) {
      if (root && root[3] > 0) base = over(root, base);
      else if (document.documentElement.dataset.theme === "dark") base = [0, 0, 0];
    }
    for (const f of fills.reverse()) base = over(f, base);
    return base;
  };

  const all = Array.from(document.body.querySelectorAll("*"));
  const elements: ProbedElement[] = [];
  const empty: ProbeResult["empty"] = [];
  const wide = new Set<Element>();
  const clips = (el: Element): boolean => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o !== "visible") return true;
    }
    return false;
  };
  const MEDIA = "img,svg,canvas,video,picture,input,select,textarea,button,progress,meter,iframe";
  all.forEach((el, i) => {
    if (el.closest("script,style,template,noscript") || !visible(el)) return;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.right > view.width + 1 && s.position !== "fixed" && !clips(el)) wide.add(el);
    const ownText = Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim() !== "");
    const fg = rgba(s.color);
    const bg = rgba(s.backgroundColor);
    const painted = !!bg && bg[3] > 0;
    if (!ownText && !painted && s.borderTopStyle === "none") return;
    const behind = behindOf(el);
    let contrast: number | undefined;
    if (ownText && fg && behind) {
      const text = over(fg, behind);
      const [a, b] = [lum(text), lum(behind)].sort((x, y) => y - x) as [number, number];
      contrast = Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
    }
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    elements.push({
      key: `${i}:${el.tagName}`,
      name: named(el),
      color: s.color,
      background: s.backgroundColor,
      ...(behind ? { behind: `rgb(${behind.map(Math.round).join(", ")})` } : {}),
      ...(contrast !== undefined ? { contrast } : {}),
      large: size >= 24 || (bold && size >= 18.66),
      hasText: ownText,
    });
    // A box drawn as a region (a fill or a border) that holds nothing at all.
    const boxed = painted || (s.borderTopStyle !== "none" && parseFloat(s.borderTopWidth) > 0);
    if (boxed && r.width >= 120 && r.height >= 60 && !(el.textContent ?? "").trim() && !el.querySelector(MEDIA) && !el.matches(MEDIA)) {
      empty.push({ name: named(el), width: Math.round(r.width), height: Math.round(r.height) });
    }
  });
  // The element that pushes past the edge, not every child it carries along.
  const overflow = [...wide].filter((el) => !el.parentElement || !wide.has(el.parentElement)).map((el) => ({ name: named(el), right: Math.round(el.getBoundingClientRect().right) }));
  // Report the outermost of each nest: an empty card's empty body is the same finding.
  const outer = empty.filter((e, i) => !empty.some((o, j) => j < i && o.width >= e.width && o.height >= e.height && e.name.startsWith(o.name.split(" ")[0]!)));
  const heading = Array.from(document.querySelectorAll("h1, [role=heading][aria-level='1'], [data-deck] section:first-of-type h2")).find((h) => (h.textContent ?? "").trim());
  const formulaErrors = Array.from(new Set(all.filter((el) => el.children.length === 0 && /^#(REF!|DIV\/0!|NAME\?|VALUE!|CYCLE!|N\/A)$/.test((el.textContent ?? "").trim())).map(named))).slice(0, 8);
  return {
    viewport: view,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    overflow: overflow.slice(0, 6),
    elements: elements.slice(0, 1500),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    empty: outer.slice(0, 6),
    title: heading ? (heading.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) : undefined,
    formulaErrors,
  };
}
