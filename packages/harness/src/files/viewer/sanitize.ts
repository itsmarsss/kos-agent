import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

/**
 * A document's HTML, cut down to what reads and nothing that acts.
 *
 * Every document view leaves the server through here, whoever wrote it: a
 * converter of KOS's own, or macOS's textutil reading a .doc. The markup is
 * parsed as a browser parses it (parse5) and written out again from an
 * allow-list, so what is not on the list is not escaped but absent: no
 * script, no handler, no frame, no form, no link that goes anywhere, no
 * picture but a raster data URI, and CSS with nothing that fetches. The
 * dashboard then draws it in a sandboxed frame with no script and a policy
 * that loads nothing, so a slip here is still not a way in.
 */

type Node = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];

/** Kept, with what is inside them. */
const TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "strong", "b", "em", "i", "u", "s", "strike", "del", "ins",
  "sub", "sup", "small", "mark", "br", "hr", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot",
  "tr", "td", "th", "colgroup", "col", "caption", "blockquote", "pre", "code", "div", "figure", "figcaption", "img",
  "section", "article", "header", "footer", "font", "center",
]);

/** Dropped with everything inside them: what runs, what embeds, what is not text. */
const DROPPED = new Set([
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math",
  "head", "title", "meta", "link", "base", "form", "input", "button", "select", "textarea", "option", "canvas",
  "audio", "video", "source", "track", "portal", "xml",
]);

const ATTRS = new Set(["class", "style", "colspan", "rowspan", "alt", "src", "width", "height", "align", "valign", "dir", "start", "type", "span"]);

/** A raster picture inline; anything else (a URL, an SVG, a script) is no source. */
const PICTURE = /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/;

/** In a declaration, what would fetch, run or hide what it does: the whole declaration goes. */
const CSS_DANGER = /url\s*\(|expression\s*\(|\\|behavior\s*:|-moz-binding|javascript:|image-set\s*\(|<\/|@/i;

/**
 * CSS made inert by dropping, never patching: comments go first (they can
 * split a word), then any at-rule that fetches (@import, @font-face,
 * @namespace), then each declaration that holds anything dangerous, whole,
 * so no removal can join two halves into something new.
 */
export function cleanCss(css: string): string {
  const plain = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, "").replace(/@(import|font-face|namespace)\b[^;{}]*(;|\{[^}]*\}?)/gi, "");
  return plain.replace(/(^|[{};])([^{};]*)(?=[;}]|$)/g, (whole, lead: string, declaration: string) => (CSS_DANGER.test(declaration) ? lead : whole));
}

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const isElement = (n: Node): n is Element => "tagName" in n;
const isText = (n: Node): n is DefaultTreeAdapterMap["textNode"] => n.nodeName === "#text";

/**
 * The fragment, cleaned. A `<style>` is kept only at the top level and only
 * as inert CSS, so a converter's class rules still apply; everything it
 * styles is inside the frame, never the dashboard.
 */
export function sanitizeHtml(html: string): string {
  const fragment = parseFragment(html);
  return fragment.childNodes.map((n) => write(n, true)).join("");
}

function write(node: Node, top: boolean): string {
  if (isText(node)) return escapeText(node.value);
  if (!isElement(node)) return "";
  const tag = node.tagName;
  // Raw text in HTML: only a "<" could end it early, so none is kept.
  if (tag === "style") return top ? `<style>${cleanCss(node.childNodes.filter(isText).map((t) => t.value).join("")).replace(/</g, "")}</style>` : "";
  if (DROPPED.has(tag) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") return "";
  const inner = node.childNodes.map((n) => write(n, false)).join("");
  // A link keeps its words and loses where it went.
  if (!TAGS.has(tag)) return inner;
  const attrs = node.attrs
    .filter((a) => !a.prefix && ATTRS.has(a.name))
    .map((a) => clean(tag, a.name, a.value))
    .filter((a): a is string => a !== undefined);
  if (tag === "img" && !attrs.some((a) => a.startsWith("src="))) return "";
  const open = `<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
  return tag === "br" || tag === "hr" || tag === "img" || tag === "col" ? open : `${open}${inner}</${tag}>`;
}

function clean(tag: string, name: string, value: string): string | undefined {
  if (name === "src") return tag === "img" && PICTURE.test(value) ? `src="${escapeAttr(value.replace(/\s+/g, ""))}"` : undefined;
  if (name === "style") {
    const css = cleanCss(value).trim();
    return css ? `style="${escapeAttr(css)}"` : undefined;
  }
  if (["colspan", "rowspan", "width", "height", "start", "span"].includes(name)) return /^\d{1,5}(%|px)?$/.test(value.trim()) ? `${name}="${value.trim()}"` : undefined;
  if (name === "class") return /^[\w\s-]{1,200}$/.test(value) ? `class="${escapeAttr(value)}"` : undefined;
  return /^[\w\s-]{0,40}$/.test(value) ? `${name}="${escapeAttr(value)}"` : undefined;
}
