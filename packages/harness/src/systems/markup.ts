import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

/**
 * Markup read as a browser reads it, not as a pattern matches it.
 *
 * A regex over HTML is fooled by a `>` inside a quoted attribute
 * (`<img alt=">" src=x onerror=...>`), by entities (`href="&#106;avascript:"`),
 * by case and by an attribute split over lines. parse5 is the HTML parsing
 * algorithm itself, so what it reports is what the frame will build: tag and
 * attribute names lower-cased, values with their entities decoded, foreign
 * (SVG) content in its namespace. Kept here, on the server; nothing of it
 * ships to the dashboard.
 */

type Node = DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];
type Attr = Element["attrs"][number];

const isElement = (node: Node): node is Element => "tagName" in node;

/** Every element under a node, template contents included, in document order. */
function* elements(node: Node): Generator<Element> {
  const children = "childNodes" in node ? node.childNodes : [];
  for (const child of children) {
    if (isElement(child)) {
      yield child;
      if (child.tagName === "template") yield* elements((child as DefaultTreeAdapterMap["template"]).content);
    }
    yield* elements(child);
  }
}

/** An attribute's name as written: `xlink:href`, `href`. */
const attrName = (a: Attr): string => (a.prefix ? `${a.prefix}:${a.name}` : a.name);

/**
 * A URL as a browser resolves its scheme: control characters and whitespace
 * anywhere in it are dropped before the scheme is read, so `java\tscript:`
 * is javascript:.
 */
const urlOf = (value: string): string => value.replace(/[\u0000- \u007f]+/g, "").toLowerCase();

/** A URL that goes off the page: any scheme, or a scheme-relative `//host`. */
const leaves = (url: string): boolean => /^([a-z][a-z0-9+.-]*:|\/\/|\\\\)/.test(url);

/** The URLs a srcset names, one per candidate. */
const srcsetUrls = (value: string): string[] => value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "").filter(Boolean);

/* ------------------------------------------------------------------ */
/* An agent's page: what would take it out of its frame.               */
/* ------------------------------------------------------------------ */

const FRAMES = new Set(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);
const MEDIA = new Set(["img", "image", "source", "video", "audio", "track", "input"]);
const AIMED = new Set(["a", "area", "form", "button", "input"]);

/**
 * What in a page's markup would reach past its frame, named for the refusal;
 * empty when nothing does. The same exits shared/htmlpage.ts reads with
 * patterns, read here from the parsed document.
 */
export function markupExits(html: string): string[] {
  const found = new Set<string>();
  const doc = parse(html, { sourceCodeLocationInfo: true });
  for (const el of elements(doc)) {
    const tag = el.tagName;
    const attr = (name: string): Attr | undefined => el.attrs.find((a) => attrName(a) === name);
    if (tag === "link") found.add("a <link> (a page loads nothing; prefetch and prerender links reach the network)");
    if (tag === "meta" && attr("http-equiv")) found.add("a <meta http-equiv> (a refresh would navigate)");
    if (FRAMES.has(tag)) found.add("a frame, object or embed");
    if (tag === "base") found.add("a <base>");
    if (tag === "form") found.add("a <form> (save with kos.write instead of posting)");
    if (tag === "script" && attr("type")?.value.trim().toLowerCase() === "speculationrules") found.add("speculation rules");
    if (AIMED.has(tag) && el.attrs.some((a) => ["target", "formaction", "ping"].includes(attrName(a)))) found.add("a link or form target");
    if (tag === "a" && attr("download")) found.add("a download link");
    if (tag === "a" || tag === "area") {
      for (const a of el.attrs.filter((x) => attrName(x) === "href" || attrName(x) === "xlink:href")) {
        const url = urlOf(a.value);
        // A javascript: link written out is code, which the code checks read; one hidden in entities is refused here.
        const written = el.sourceCodeLocation?.attrs?.[attrName(a)];
        const literal = written ? html.slice(written.startOffset, written.endOffset).toLowerCase().includes("javascript:") : false;
        if (url.startsWith("javascript:") ? !literal : leaves(url)) found.add("a link off the page (link within it with #id)");
      }
    }
    // An SVG reference: <use> draws another document's symbol, <feImage> loads an image; within the page, #id.
    if (tag.toLowerCase() === "use" || tag.toLowerCase() === "feimage") {
      const off = el.attrs.some((a) => (attrName(a) === "href" || attrName(a) === "xlink:href") && !a.value.trim().startsWith("#") && !urlOf(a.value).startsWith("data:"));
      if (off) found.add("an SVG <use> or <feImage> from outside the page (refer within it with #id)");
    }
    if (MEDIA.has(tag)) {
      for (const a of el.attrs) {
        const name = attrName(a);
        const urls = name === "srcset" ? srcsetUrls(a.value) : ["src", "poster", "href", "xlink:href"].includes(name) ? [a.value] : [];
        if (urls.some((u) => /^(https?:)?\/\//.test(urlOf(u)))) found.add("an image or media from the network (inline it as data:)");
      }
    }
  }
  return [...found];
}

/* ------------------------------------------------------------------ */
/* The owner's edit to a doc: only what the editor and a doc are made of. */
/* ------------------------------------------------------------------ */

/** Elements a doc's text is made of: the editor's blocks and marks, and the doc structure the agent writes. */
const DOC_TAGS = new Set([
  "a", "abbr", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd", "li", "mark", "nav", "ol", "p", "picture",
  "pre", "q", "s", "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
  // A figure's chart, drawn as SVG.
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "marker",
]);

/** What each may carry. Every element takes the global ones. */
const GLOBAL_ATTRS = new Set(["id", "class", "title", "lang", "dir", "role", "hidden", "style", "translate", "spellcheck"]);
const ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height", "loading", "decoding"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  time: new Set(["datetime"]),
  q: new Set(["cite"]),
  blockquote: new Set(["cite"]),
  del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]),
  details: new Set(["open"]),
  use: new Set(["href", "xlink:href"]),
};
/** An SVG drawing's presentation, on any SVG element. */
const SVG_ATTRS = new Set([
  "viewbox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill",
  "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap",
  "stroke-linejoin", "transform", "opacity", "font-size", "font-weight", "font-family", "text-anchor",
  "dominant-baseline", "preserveaspectratio", "xmlns", "xmlns:xlink", "offset", "stop-color", "stop-opacity",
  "gradientunits", "gradienttransform", "clip-path", "mask", "dx", "dy", "focusable", "vector-effect",
  "clippathunits", "patternunits", "markerwidth", "markerheight", "refx", "refy", "orient", "marker-end", "marker-start",
]);
const SVG = "http://www.w3.org/2000/svg";

/** Why an edit is refused: code in text, or a way out of the frame. */
export class EditRefusal extends Error {}

const code = (what: string): EditRefusal => new EditRefusal(`an edit is text, so it may not hold ${what}`);
const exit = (what: string): EditRefusal => new EditRefusal(`a page cannot leave its frame, so an edit may not hold ${what}`);

/** Elements whose presence is code or a way out, named as the refusals always have. */
function refuseTag(tag: string): EditRefusal {
  if (tag === "script") return code("a script");
  if (tag === "style") return code("a stylesheet");
  if (tag === "article") return code("an article tag");
  if (FRAMES.has(tag)) return exit("a frame, object or embed");
  if (tag === "form" || tag === "input" || tag === "button" || tag === "select" || tag === "textarea") return exit("a form or its controls");
  if (tag === "link" || tag === "meta" || tag === "base") return exit(`a <${tag}>`);
  if (tag === "image" || tag === "video" || tag === "audio" || tag === "source") return exit("media from outside the page (an image is kept in it as data)");
  return code(`a <${tag}>, which a doc is not made of`);
}

/** SVG presentation attributes that can name a resource with url(): a paint, a mask, a clip, a filter, a marker. */
const SVG_REFS = new Set(["fill", "stroke", "mask", "clip-path", "filter", "marker-start", "marker-mid", "marker-end", "cursor"]);

/**
 * Whether a CSS value (a style attribute, an SVG presentation attribute) could
 * load or run something. Any backslash is refused rather than decoded: a CSS
 * escape (`u\72l(`) spells url( to the browser and to no pattern. Then a
 * url( to anything but the page's own #id, an image-set( or image(, and the
 * old expression( and @import.
 */
const cssReaches = (value: string): boolean =>
  value.includes("\\") ||
  /url\s*\((?!\s*['"]?\s*#)/i.test(value) ||
  /(^|[^\w-])(-webkit-)?image(-set)?\s*\(|(^|[^\w-])src\s*\(|expression\s*\(|@import/i.test(value);

/** Attributes that fetch or go somewhere, whatever element carries them. */
const FETCHES = new Set(["srcset", "poster", "action", "formaction", "ping", "background", "lowsrc", "data", "codebase"]);

/** What an attribute does that a doc's text may not: code, or a way out of the frame. Checked before whether the element is a doc's at all, so the refusal names the worse of the two. */
function checkReach(a: Attr): void {
  const name = attrName(a).toLowerCase();
  if (name.startsWith("on")) throw code("an event handler");
  const url = urlOf(a.value);
  if (url.includes("javascript:") && ["href", "xlink:href", "src", "style", "action", "formaction"].includes(name)) throw code("a javascript: URL");
  // Within the page only: a link to one of its headings, an image held in it as data.
  if ((name === "href" || name === "xlink:href") && !a.value.trim().startsWith("#")) throw exit("a link off the page (link to a heading with #id)");
  if (name === "src" && !url.startsWith("data:image/")) throw exit("an image from outside the page (an image is kept in it as data)");
  if (FETCHES.has(name)) throw exit(`${name}, which reaches outside the page`);
  if (name === "cite" && leaves(url)) throw exit("a citation URL");
  if (name === "style" && cssReaches(a.value)) throw code("a style that loads or runs something");
  if (SVG_REFS.has(name) && cssReaches(a.value)) throw exit(`${name} naming something outside the page (refer within it with url(#id))`);
}

/** Whether a doc's element may carry this attribute. */
function allowedAttr(el: Element, a: Attr): boolean {
  const name = attrName(a).toLowerCase();
  if (GLOBAL_ATTRS.has(name) || name.startsWith("data-") || name.startsWith("aria-")) return true;
  if (ATTRS[el.tagName.toLowerCase()]?.has(name)) return true;
  return el.namespaceURI === SVG && SVG_ATTRS.has(name);
}

/**
 * The owner's edit to a doc's text, as markup the doc may take: parsed as a
 * browser would inside the article, checked element by element against what
 * a doc is made of, and written back out from the parse. What is saved is
 * the serialisation, so a stray end tag or an unclosed element in the text
 * cannot end the article early or reach past it.
 */
export function docEditOf(text: string): string {
  const fragment = parseFragment(text);
  for (const el of elements(fragment)) {
    for (const a of el.attrs) checkReach(a);
    const tag = el.tagName.toLowerCase();
    if (!DOC_TAGS.has(tag)) throw refuseTag(tag);
    const odd = el.attrs.find((a) => !allowedAttr(el, a));
    if (odd) throw code(`the attribute ${attrName(odd)} on <${tag}>, which a doc's text does not carry`);
  }
  return serialize(fragment);
}
