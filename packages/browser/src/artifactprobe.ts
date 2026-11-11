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
  /** Text cut off by a box that hides what overflows it, and that box. */
  clipped: { name: string; by: string }[];
  /** Two runs of text drawn over each other. */
  overlaps: { a: string; b: string }[];
  /** KOS's own ground for the theme, from the tokens the shell set, and what shows behind the body's text. */
  ground: { kos: string; body: string };
  /** Large areas painted in the other theme's brightness: a dark slab on a light page, a light one on a dark page. */
  inverted: { name: string; width: number; height: number }[];
  /** Wide boxes with a border all round, each wrapping a section's content (a table, a list, a chart, a form, another box). */
  wrappers: { name: string; depth: number }[];
  /** Big figures that say nothing: a placeholder (a dash, n/a), or a zero in a row of figures that all read zero. */
  blankFigures: { name: string; text: string }[];
  /** Bars whose fill cannot draw: an inline fill (it ignores width), a fill given a width that draws none, a .meter with no --value. */
  emptyBars: string[];
}

import type { Rgba } from "@kos/shared";

/**
 * The function serialised into the frame; it must not close over anything.
 * It is handed @kos/shared's colourOf, serialised beside it, so every colour
 * a browser computes (oklch, color-mix, hsl) is read the same way the bridge
 * reads a page's ground.
 */
export function probe(colourOf: (css: string) => Rgba | undefined): ProbeResult {
  const view = { width: document.documentElement.clientWidth, height: window.innerHeight };
  const named = (el: Element): string => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  // What is not rendered still gets a box: a closed <details>' contents, content-visibility: hidden, hidden=until-found.
  const visible = (el: Element): boolean => {
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ contentVisibilityAuto: false, opacityProperty: true, visibilityProperty: true })) return false;
    } else {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      if (el.parentElement?.closest("details:not([open])") && !el.closest("summary")) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const rgba = (c: string): Rgba | undefined => colourOf(c);
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

  // The part of a box left in view by every ancestor that clips or scrolls: rows scrolled out of a grid are not on screen.
  const shown = (el: Element, r: DOMRect): DOMRect | undefined => {
    let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const o = getComputedStyle(n);
      if (o.overflowX === "visible" && o.overflowY === "visible") continue;
      const c = n.getBoundingClientRect();
      [l, t, rt, b] = [Math.max(l, c.left), Math.max(t, c.top), Math.min(rt, c.right), Math.min(b, c.bottom)];
    }
    return rt - l > 0 && b - t > 0 ? new DOMRect(l, t, rt - l, b - t) : undefined;
  };
  const all = Array.from(document.body.querySelectorAll("*"));
  const elements: ProbedElement[] = [];
  const empty: ProbeResult["empty"] = [];
  const wide = new Set<Element>();
  const clipped: ProbeResult["clipped"] = [];
  const texts: { el: Element; r: DOMRect }[] = [];
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
    if (ownText && s.position !== "fixed" && s.position !== "sticky" && texts.length < 600) {
      // Each line of its own words, not its children's: a line box per rect.
      const range = document.createRange();
      for (const c of Array.from(el.childNodes)) {
        if (c.nodeType !== 3 || !(c.textContent ?? "").trim()) continue;
        range.selectNodeContents(c);
        for (const r of Array.from(range.getClientRects())) {
          const seen = shown(el, r);
          if (seen) texts.push({ el, r: seen });
        }
      }
    }
    if (ownText && clipped.length < 6 && s.textOverflow !== "ellipsis") {
      // Where the words really are, against every box above that cuts off what spills out of it.
      const range = document.createRange();
      range.selectNodeContents(el);
      const t = range.getBoundingClientRect();
      for (let n = el.parentElement ?? null, self: Element = el; n && n !== document.documentElement; self = n, n = n.parentElement) {
        const box = [self, n].find((b) => /hidden|clip/.test(getComputedStyle(b).overflowX));
        if (!box) continue;
        const b = box.getBoundingClientRect();
        if (t.width > 0 && (t.left < b.left - 2 || t.right > b.right + 2)) clipped.push({ name: named(el), by: named(box).split(" ")[0]! });
        break;
      }
    }
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
  // Words drawn over other words: two text boxes, neither inside the other, crossing by more than a hair.
  const overlaps: ProbeResult["overlaps"] = [];
  for (let i = 0; i < texts.length && overlaps.length < 4; i++) {
    for (let j = i + 1; j < texts.length && overlaps.length < 4; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 4 && h > 4 && a.r.width > 0 && b.r.width > 0) overlaps.push({ a: named(a.el), b: named(b.el) });
    }
  }
  /*
   * The look: what the guide calls generated. A large area in the other
   * theme's brightness (an inverted slide or band), boxes wrapping each
   * section, big figures with nothing to say, and bars that draw nothing.
   */
  const dark = document.documentElement.dataset.theme === "dark";
  const inverted: ProbeResult["inverted"] = [];
  const wrappers: ProbeResult["wrappers"] = [];
  const blankFigures: ProbeResult["blankFigures"] = [];
  /** Every big figure, by the row it sits in (its tile's parent), to tell a row of zeros from one zero among figures. */
  const figureRows = new Map<Element | null, { name: string; text: string; blank: boolean }[]>();
  const emptyBars: string[] = [];
  const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  // What a section holds; a button alone is an object's action, not structure.
  const STRUCTURE = "table,ul,ol,svg,canvas,input,select,textarea,figure";
  // A runtime's own furniture (a sheet's grid and charts, a doc's contents, a deck's frames) is KOS's, not the artifact's.
  const runtimes = (el: Element): boolean => typeof el.className === "string" && /(^|\s)(sheet|doc|deck)-/.test(el.className);
  const ZERO = /^[$€£]?\s?0([.,]0+)?\s?%?$/;
  const PLACEHOLDER = /^([-–—]+|n\/?a|null|undefined|NaN|tbd|…|\.\.\.)$/i;
  const FIGURE = /^[$€£]?\s?[-+]?[\d.,]+\s?(%|[a-z]{1,3})?$/i;
  // A section's head: a heading, or a short first line set bold.
  const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const headed = (el: Element): boolean => {
    if (el.querySelector(HEADING)) return true;
    const first = el.firstElementChild;
    const text = (first?.textContent ?? "").trim();
    return !!first && text.length > 0 && text.length <= 60 && Number(getComputedStyle(first).fontWeight) >= 600;
  };
  // One of a set of objects: with no heading of its own, an item or an article, or one of siblings alike laid side by side (a grid of cards).
  const listed = (el: Element, r: DOMRect): boolean =>
    !el.querySelector(HEADING) &&
    (el.matches("li,article") ||
    Array.from(el.parentElement?.children ?? []).some((sib) => {
      if (sib === el || sib.tagName !== el.tagName || sib.className !== el.className) return false;
      const o = sib.getBoundingClientRect();
      return Math.abs(o.top - r.top) < 4;
    }));
  const ringed = (s: CSSStyleDeclaration): boolean =>
    (["Top", "Right", "Bottom", "Left"] as const).every((side) => s[`border${side}Style`] !== "none" && parseFloat(s[`border${side}Width`]) > 0 && (rgba(s[`border${side}Color`])?.[3] ?? 0) > 0);
  const boxes = new Set<Element>();
  for (const el of all) {
    if (el.closest("script,style,template,noscript,svg") || el.matches(MEDIA + ",table,thead,tbody,tr,td,th") || !visible(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const fill = rgba(s.backgroundColor);
    if (fill && fill[3] >= 0.6 && r.width >= view.width * 0.5 && r.height >= 100) {
      const seen = shown(el, r);
      const back = behindOf(el);
      if (seen && seen.height >= 100 && back) {
        const l = lum(back);
        if ((dark && l > 0.45) || (!dark && l < 0.18)) inverted.push({ name: named(el), width: Math.round(seen.width), height: Math.round(seen.height) });
      }
    }
    if (ringed(s) && !runtimes(el)) boxes.add(el);
    const own = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    // A figure: the kit's .stat-value, or a leaf in large type, reading a number or a placeholder, with words beside it (its label).
    const big = el.classList.contains("stat-value") || parseFloat(s.fontSize) >= Math.min(22, rootSize * 1.375);
    if (el.children.length === 0 && own && big && (FIGURE.test(own) || PLACEHOLDER.test(own))) {
      const label = (el.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (label.length > own.length) {
        const row = el.parentElement?.parentElement ?? null;
        figureRows.set(row, [...(figureRows.get(row) ?? []), { name: named(el.parentElement ?? el), text: own, blank: ZERO.test(own) || PLACEHOLDER.test(own) }]);
        if (PLACEHOLDER.test(own)) blankFigures.push({ name: named(el.parentElement ?? el), text: own });
      }
    }
    // A bar's track: short, wide and painted, holding its fill. A bar at zero is data; a fill that cannot draw is a bug.
    if (fill && fill[3] > 0 && r.height <= 16 && r.width >= 60 && r.width >= r.height * 6) {
      const broken = Array.from(el.children).some((c) => {
        const given = (c as HTMLElement).style?.width ?? "";
        return getComputedStyle(c).display === "inline" || (parseFloat(given) > 0 && c.getBoundingClientRect().width < 1);
      });
      const unset = el.matches(".meter") && el.children.length === 0 && !s.getPropertyValue("--value").trim();
      if (broken || unset) emptyBars.push(named(el));
    }
  }
  for (const figures of figureRows.values()) {
    if (figures.length >= 2 && figures.every((f) => f.blank)) for (const f of figures) if (ZERO.test(f.text)) blankFigures.push({ name: f.name, text: f.text });
  }
  // A section wrapper: a wide box with a border all round, holding a head and structure (a table, a list, a chart, a form, another box), and not one of a set of objects.
  for (const el of boxes) {
    const r = el.getBoundingClientRect();
    if (r.width < view.width * 0.25 || r.height < 80 || listed(el, r) || !headed(el)) continue;
    const holds = el.querySelector(STRUCTURE) !== null || [...boxes].some((b) => b !== el && el.contains(b));
    if (!holds) continue;
    let depth = 1;
    for (let n = el.parentElement; n; n = n.parentElement) if (boxes.has(n)) depth += 1;
    wrappers.push({ name: named(el), depth });
  }
  const kosBg = colourOf(/--bg:([^;}]+)/.exec(document.getElementById("kos-tokens")?.textContent ?? "")?.[1]?.trim() ?? "");
  const bodyGround = behindOf(document.body);
  const rgb = (c: number[]): string => `rgb(${c.slice(0, 3).map(Math.round).join(", ")})`;

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
    clipped,
    overlaps,
    ground: { kos: kosBg ? rgb(kosBg) : "", body: bodyGround ? rgb(bodyGround) : "" },
    // The outermost of each: a slide inside a dark stage is one finding.
    inverted: inverted.filter((e, i) => !inverted.some((o, j) => j < i && e.name !== o.name && o.width >= e.width && o.height >= e.height)).slice(0, 4),
    wrappers: wrappers.slice(0, 12),
    blankFigures: blankFigures.slice(0, 8),
    emptyBars: emptyBars.slice(0, 4),
  };
}
