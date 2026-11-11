import { defaultTreeAdapter, parse, serialize, type DefaultTreeAdapterMap } from "parse5";

/**
 * A drawn artifact as a document safe to print: its snapshot rebuilt on the
 * server against what a printed page is made of, and nothing else.
 *
 * The snapshot is the artifact's own frame read after its code ran, so it is
 * whatever that code chose to hand back: a page can replace outerHTML and
 * every DOM method it calls. It is treated as untrusted text. It is parsed as
 * a browser parses it (parse5) and only an allowlist of elements and
 * attributes is kept: no script, no frame, object or embed, no form or
 * control that acts, no link, meta or base, no event handler, no srcdoc, no
 * URL but the page's own #id and data: images, no animation that could set
 * one, no foreignObject; styles keep their rules but lose every url() to
 * anything but data: or #id, and every @import. Then the print tab adds its
 * own locks (no script, offline, a policy that loads nothing): this is the
 * first.
 */

type Node = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];
type Parent = DefaultTreeAdapterMap["parentNode"];

const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const MATHML = "http://www.w3.org/1998/Math/MathML";

/** What a printed page's HTML is made of. */
const HTML_TAGS = new Set([
  "html", "head", "body", "title", "style", "main", "article", "section", "aside", "header", "footer", "nav", "hgroup", "address",
  "div", "span", "p", "br", "hr", "wbr", "h1", "h2", "h3", "h4", "h5", "h6", "a", "abbr", "b", "i", "em", "strong", "small", "sub",
  "sup", "u", "s", "del", "ins", "mark", "q", "cite", "dfn", "code", "kbd", "samp", "var", "pre", "time", "data", "bdi", "bdo",
  "ruby", "rt", "rp", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "figure", "figcaption", "table", "caption", "thead",
  "tbody", "tfoot", "tr", "th", "td", "col", "colgroup", "img", "details", "summary", "label", "meter", "progress", "output",
  // A doc's note numbers and a deck's controls are buttons; with no script and no form they only show.
  "button",
]);

/** An SVG drawing, without its scripts, its foreign content, its animations or an image from elsewhere. */
const SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textpath", "title", "desc",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "marker", "image", "a",
  "style", "filter", "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix", "fediffuselighting",
  "fedisplacementmap", "fedistantlight", "fedropshadow", "feflood", "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur",
  "femerge", "femergenode", "femorphology", "feoffset", "fepointlight", "fespecularlighting", "fespotlight", "fetile",
  "feturbulence",
]);

/** Mathematics as MathML lays it out, without its actions or foreign annotations. */
const MATHML_TAGS = new Set([
  "math", "mi", "mn", "mo", "ms", "mtext", "mspace", "mrow", "mfrac", "msqrt", "mroot", "msub", "msup", "msubsup", "munder",
  "mover", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom", "menclose", "semantics", "annotation",
]);

/** What any HTML element may carry. */
const GLOBAL_ATTRS = new Set(["id", "class", "style", "title", "lang", "dir", "role", "hidden", "translate"]);
/** What particular HTML elements may carry besides. */
const HTML_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  time: new Set(["datetime"]),
  data: new Set(["value"]),
  details: new Set(["open"]),
  button: new Set(["type", "disabled"]),
  meter: new Set(["value", "min", "max", "low", "high", "optimum"]),
  progress: new Set(["value", "max"]),
};

/** Never kept, on any element of any namespace: what loads, acts or goes somewhere. */
const NEVER = new Set(["srcdoc", "srcset", "action", "formaction", "form", "ping", "poster", "background", "lowsrc", "data", "codebase", "target", "download", "http-equiv", "manifest", "attributename"]);

/** A URL as a browser reads its scheme: control characters and spaces anywhere in it dropped. */
const schemeOf = (value: string): string => value.replace(/[\u0000- \u007f]+/g, "").toLowerCase();
const runs = (value: string): boolean => /(javascript|vbscript):|data:text\/html/.test(schemeOf(value));

/**
 * CSS with every escape that spells a name's own character written as that
 * character: `u\rl(`, `\75 rl(` and `@im\port` are url( and @import to the
 * browser, and must be to the filters below. Only letters, digits and `( ) @
 * _ -` are decoded, which mean the same written either way; an escaped quote,
 * backslash or line break is left escaped, so no string ends early.
 */
export function plainCss(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([^\r\n\f0-9a-fA-F])/g, (whole: string, hex: string | undefined, char: string | undefined) => {
    const c = hex !== undefined ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char!;
    return /^[A-Za-z0-9()@_-]$/.test(c) ? c : whole;
  });
}

/** What a URL in CSS may be: the page's own data, or a place on it. */
const KEPT_URL = /^\s*['"]?\s*(data:(image|font|application\/font)|#)/i;

/** A CSS text without anything it could load: escapes read first, then every url() to elsewhere and every @import gone. */
export function printCss(css: string): string {
  return plainCss(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)([^)]*?)\1\s*\)/gi, (whole, _q: string, target: string) => (KEPT_URL.test(target) ? whole : "none"))
    // An url( the pattern above did not close (one left open to the end of a rule) is no url at all.
    .replace(/url\((?![^)]*\))/gi, "none(")
    .replace(/url\((?!\s*['"]?\s*(data:(image|font|application\/font)|#))/gi, "none(")
    .replace(/(^|[^\w-])(-webkit-)?image(-set)?\s*\(/gi, "$1none(")
    .replace(/(^|[^\w-])src\s*\(/gi, "$1none(")
    .replace(/expression\s*\(/gi, "none(");
}

/** Whether a presentation attribute's value names something to load: any url( but to the page's own #id, read with its escapes. */
const loadsCss = (value: string): boolean => {
  const plain = plainCss(value);
  return /url\s*\((?!\s*['"]?\s*#)|image(-set)?\s*\(|(^|[^\w-])src\s*\(|@import|expression\s*\(/i.test(plain);
};

/** Whether an element of this namespace and name is a printed page's. */
function allowedTag(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (el.namespaceURI === HTML) return HTML_TAGS.has(tag);
  if (el.namespaceURI === SVG) return SVG_TAGS.has(tag);
  if (el.namespaceURI === MATHML) return MATHML_TAGS.has(tag);
  return false;
}

/** An attribute's value as kept, or undefined when it goes. */
function keptValue(el: Element, a: { name: string; prefix?: string; value: string }): string | undefined {
  const name = (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (name.startsWith("on") || NEVER.has(name) || runs(a.value)) return undefined;
  if (name === "style") return printCss(a.value);
  if (name === "href" || name === "xlink:href") {
    if (a.value.trim().startsWith("#")) return a.value;
    // An SVG image held in the page as data is its own picture.
    return tag === "image" && /^data:image\//i.test(a.value.trim()) ? a.value : undefined;
  }
  if (name === "src") return /^(data:image\/|blob:)/i.test(a.value.trim()) ? a.value : undefined;
  if (el.namespaceURI === HTML) {
    if (GLOBAL_ATTRS.has(name) || name.startsWith("data-") || name.startsWith("aria-")) return a.value;
    if (tag === "html" && name === "xmlns") return a.value;
    return HTML_ATTRS[tag]?.has(name) ? a.value : undefined;
  }
  // SVG and MathML presentation: any, but none that names something outside the page (fill, stroke, filter, mask, clip-path, marker-*, cursor...).
  return loadsCss(a.value) ? undefined : a.value;
}

function clean(parent: Parent): void {
  const kept: Node[] = [];
  for (const node of parent.childNodes) {
    if (node.nodeName === "#comment" || node.nodeName === "#documentType") continue;
    if (!("tagName" in node)) {
      kept.push(node);
      continue;
    }
    if (!allowedTag(node)) continue;
    node.attrs = node.attrs.flatMap((a) => {
      const value = keptValue(node, a);
      return value === undefined ? [] : [{ ...a, value }];
    });
    if (node.tagName.toLowerCase() === "style") {
      // A style holds its rules and nothing else: in SVG it can hold elements, which go unread.
      node.childNodes = node.childNodes.filter((c) => c.nodeName === "#text");
      for (const text of node.childNodes) (text as DefaultTreeAdapterMap["textNode"]).value = printCss((text as DefaultTreeAdapterMap["textNode"]).value);
    } else clean(node);
    kept.push(node);
  }
  parent.childNodes = kept;
}

/** The policy the print document carries in its own head, first: it loads nothing but data: images and fonts, and runs nothing. */
export const PRINT_CSP = "default-src 'none'; script-src 'none'; frame-src 'none'; connect-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/** The snapshot rebuilt as a document safe to print, under PRINT_CSP, first in its real head, built as nodes and never spliced into text. */
export function printDocument(snapshot: string, extraCss = ""): string {
  const document = parse(snapshot);
  clean(document);
  const a = defaultTreeAdapter;
  const element = (tag: string, attrs: Record<string, string>): Element => a.createElement(tag, HTML as never, Object.entries(attrs).map(([name, value]) => ({ name, value })));
  let html = document.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "html");
  if (!html) {
    html = element("html", {});
    a.appendChild(document, html);
  }
  let head = html.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "head");
  if (!head) {
    head = element("head", {});
    a.insertBefore(html, head, html.childNodes[0]!);
  }
  head.attrs = [];
  const first = head.childNodes[0];
  for (const meta of [element("meta", { "http-equiv": "Content-Security-Policy", content: PRINT_CSP }), element("meta", { charset: "utf-8" })]) {
    if (first) a.insertBefore(head, meta, first);
    else a.appendChild(head, meta);
  }
  if (extraCss) {
    const style = element("style", {});
    a.insertText(style, printCss(extraCss));
    a.appendChild(head, style);
  }
  return `<!doctype html>${serialize(document)}`;
}

/** What reaches out before any policy or interception sees it: a preconnect or DNS prefetch hint, a refresh, a base. */
const HINTS = new Set(["link", "meta", "base"]);

function dropHints(parent: Parent): void {
  parent.childNodes = parent.childNodes.filter((n) => !("tagName" in n && HINTS.has(n.tagName.toLowerCase())));
  for (const n of parent.childNodes) {
    if ("tagName" in n) dropHints(n.tagName === "template" ? (n as DefaultTreeAdapterMap["template"]).content : n);
  }
}

/**
 * The artifact's own document with every link, meta and base taken out,
 * however it was written, before KOS draws or exports it. A preconnect or a
 * DNS prefetch is made by the browser's network service beside any request
 * interception or page policy, so the only sure stop is never to hand the
 * hint over; the write-time lint refuses them too, but an export does not
 * rely on what was stored.
 */
export function withoutHints(html: string): string {
  const document = parse(html);
  dropHints(document);
  return serialize(document);
}
