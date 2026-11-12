/**
 * What a paste brings into a doc: markup from another page or editor (a web
 * page, Google Docs, Notion, Word) read for its structure and nothing else.
 * Headings, paragraphs, lists, to-dos, quotes, code, tables, dividers and
 * pictures held as data are kept, with bold, italic, underline, strike,
 * code and highlight in the text; a link is kept only when it goes to a
 * place in this doc. Styles, classes, ids, scripts and anything that loads
 * are dropped, so what lands is the doc's own markup and passes the server's
 * allowlist as typed text would. The doc's own marks (a callout, a colour, a
 * highlight, a mention by an artifact's id) come through, so a copy within a
 * doc keeps them.
 */

import { ARTIFACT_ID_RE, DOC_EDIT_MAX } from "@kos/shared/artifacts";

/** What a pasted element becomes: a tag of the doc's, "unwrap" to keep only what it holds, "drop" to lose it whole. */
const MAP: Record<string, string> = {
  P: "p", DIV: "p", H1: "h1", H2: "h2", H3: "h3", H4: "h3", H5: "h3", H6: "h3",
  UL: "ul", OL: "ol", LI: "li", BLOCKQUOTE: "blockquote", PRE: "pre", HR: "hr", BR: "br",
  TABLE: "table", THEAD: "thead", TBODY: "tbody", TFOOT: "tfoot", TR: "tr", TD: "td", TH: "th", CAPTION: "caption",
  FIGURE: "figure", FIGCAPTION: "figcaption", IMG: "img",
  B: "strong", STRONG: "strong", I: "em", EM: "em", U: "u", S: "s", STRIKE: "s", DEL: "s", CODE: "code", KBD: "code",
  MARK: "mark", SUB: "sub", SUP: "sup", A: "a", DETAILS: "details", SUMMARY: "summary",
};
const DROP = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "HEAD", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "SVG", "CANVAS", "VIDEO", "AUDIO", "SOURCE", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "FORM", "BASE", "COLGROUP", "COL"]);
/** The colours a doc's words and highlights take (tc-*, hl-*), and a callout's. */
const TONE = /^(tc|hl)-(muted|accent|ok|warn|danger)$/;
const CALLOUTS = new Set(["warn", "ok", "danger", "note"]);
const BLOCKS = new Set(["p", "h1", "h2", "h3", "ul", "ol", "blockquote", "pre", "hr", "table", "figure", "details", "aside"]);
/**
 * The biggest image file a doc takes inline. Base64 makes it about 4/3 its
 * size, and the edit as a whole saves at most DOC_EDIT_MAX characters, so a
 * picture is kept to well under that, leaving room for the words.
 */
export const IMAGE_MAX = Math.floor((DOC_EDIT_MAX * 3) / 4 / 2);
/** The same cap as a data URL, for a picture that comes pasted as one: base64 of IMAGE_MAX bytes and its "data:image/…;base64," start. */
export const PASTE_IMAGE_MAX = Math.ceil(IMAGE_MAX / 3) * 4 + 32;

/** A span's inline style read as the mark it stands for (Google Docs writes bold and italic so). */
function styleMarks(el: Element): string[] {
  const style = (el.getAttribute("style") ?? "").toLowerCase();
  const marks: string[] = [];
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(style)) marks.push("strong");
  if (/font-style\s*:\s*italic/.test(style)) marks.push("em");
  if (/text-decoration[^;]*underline/.test(style)) marks.push("u");
  if (/text-decoration[^;]*line-through/.test(style)) marks.push("s");
  return marks;
}

/**
 * Pasted markup as the doc's own blocks: a fragment of `owner`'s nodes made
 * from what `source` holds, by the rules above.
 */
export function cleanPaste(source: ParentNode, owner: Document): DocumentFragment {
  const out = owner.createDocumentFragment();
  const copy = (from: Node, into: Node): void => {
    for (const node of from.childNodes) {
      if (node.nodeType === 3) {
        into.appendChild(owner.createTextNode((node as Text).data.replace(/ /g, " ")));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tag = el.tagName.toUpperCase();
      if (DROP.has(tag)) continue;
      // Google Docs wraps a whole paste in a bold that is not bold.
      const fake = tag === "B" && /font-weight\s*:\s*normal/i.test(el.getAttribute("style") ?? "");
      const classes = [...el.classList];
      // The doc's own marks, copied from it or another doc: a callout and its colour, a colour, a highlight, a mention.
      if (tag === "ASIDE" && classes.includes("callout")) {
        const aside = owner.createElement("aside");
        aside.className = ["callout", ...classes.filter((c) => CALLOUTS.has(c))].join(" ");
        copy(el, aside);
        into.appendChild(aside);
        continue;
      }
      if (tag === "SPAN" && classes.includes("mention")) {
        const id = el.getAttribute("data-artifact") ?? "";
        if (ARTIFACT_ID_RE.test(id) && id.length <= 120) {
          const chip = owner.createElement("span");
          chip.className = "mention";
          chip.setAttribute("data-artifact", id);
          chip.textContent = (el.textContent ?? "").slice(0, 200);
          into.appendChild(chip);
        } else into.appendChild(owner.createTextNode(el.textContent ?? ""));
        continue;
      }
      const colour = tag === "SPAN" ? classes.find((c) => TONE.test(c) && c.startsWith("tc-")) : undefined;
      const to = fake ? undefined : MAP[tag];
      if (colour) {
        const span = owner.createElement("span");
        span.className = colour;
        let target: Node = span;
        for (const m of styleMarks(el)) target = target.appendChild(owner.createElement(m));
        copy(el, target);
        into.appendChild(span);
        continue;
      }
      if (!to) {
        const marks = tag === "SPAN" ? styleMarks(el) : [];
        let target: Node = into;
        for (const m of marks) target = target.appendChild(owner.createElement(m));
        copy(el, target);
        continue;
      }
      if (to === "a") {
        const href = el.getAttribute("href") ?? "";
        if (!/^#[\w-]+$/.test(href)) {
          copy(el, into);
          continue;
        }
      }
      if (to === "img") {
        const src = el.getAttribute("src") ?? "";
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src) || src.length > PASTE_IMAGE_MAX) continue;
      }
      const made = owner.createElement(to);
      if (to === "a") made.setAttribute("href", el.getAttribute("href")!);
      if (to === "img") {
        made.setAttribute("src", el.getAttribute("src")!.replace(/\s+/g, ""));
        made.setAttribute("alt", el.getAttribute("alt") ?? "");
      }
      for (const span of ["colspan", "rowspan"]) {
        const n = parseInt(el.getAttribute(span) ?? "", 10);
        if ((to === "td" || to === "th") && el.hasAttribute(span)) made.setAttribute(span, String(Math.min(50, Math.max(1, Number.isFinite(n) ? n : 1))));
      }
      if (to === "mark") {
        const hl = classes.find((c) => TONE.test(c) && c.startsWith("hl-"));
        if (hl) made.className = hl;
      }
      if (to === "details" && el.hasAttribute("open")) made.setAttribute("open", "");
      // A to-do from another editor: a checklist item, ticked or not.
      if (to === "li") {
        const box = el.querySelector('input[type="checkbox"]');
        const checked = el.getAttribute("data-checked") ?? (box ? String(box.hasAttribute("checked")) : undefined);
        if (checked !== undefined) made.setAttribute("data-checked", checked === "true" ? "true" : "false");
      }
      // A list of checkboxes is a to-do list; one with a box in only some of its items stays a list.
      const items = [...el.children].filter((c) => c.tagName === "LI");
      if (to === "ul" && (el.classList.contains("checklist") || (items.length && items.every((li) => li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'))))) made.className = "checklist";
      if (to === "pre") {
        const code = el.querySelector("code");
        const lang = [...(code?.classList ?? [])].find((c) => /^language-[\w+-]{1,24}$/.test(c));
        const inner = owner.createElement("code");
        if (lang) inner.className = lang;
        inner.textContent = el.textContent ?? "";
        made.append(inner);
        into.appendChild(made);
        continue;
      }
      if (to === "hr" || to === "br" || to === "img") {
        into.appendChild(made);
        continue;
      }
      copy(el, made);
      into.appendChild(made);
    }
  };
  copy(source, out);
  tidy(out, owner);
  return out;
}

/** Blocks nested where a doc has none (a paragraph in a span, a heading in a list item's text) flattened; empty ones gone; checklists' items given a state. */
function tidy(root: DocumentFragment, owner: Document): void {
  // A paragraph inside a paragraph, from a div of divs: the outer one goes.
  for (const p of [...root.querySelectorAll("p")]) {
    if (p.querySelector("p, h1, h2, h3, ul, ol, blockquote, pre, table, figure, hr, details, aside")) p.replaceWith(...p.childNodes);
  }
  for (const el of [...root.querySelectorAll("li > p, td > p, th > p, blockquote > p:only-child, summary > p")]) {
    if (el.nextSibling) el.after(owner.createElement("br"));
    el.replaceWith(...el.childNodes);
  }
  for (const el of [...root.querySelectorAll("p, h1, h2, h3, li, blockquote, strong, em, u, s, mark, code, a, sub, sup")]) {
    if (!el.textContent?.trim() && !el.querySelector("img, br, hr, table") && el.tagName !== "LI") el.remove();
  }
  for (const li of root.querySelectorAll("ul.checklist > li:not([data-checked])")) li.setAttribute("data-checked", "false");
  for (const li of root.querySelectorAll("ul:not(.checklist) > li[data-checked], ol > li[data-checked]")) li.removeAttribute("data-checked");
  // A list item outside a list takes one.
  for (const li of [...root.querySelectorAll("li")]) {
    if (li.parentElement?.matches("ul, ol")) continue;
    const ul = owner.createElement("ul");
    li.replaceWith(ul);
    ul.append(li);
  }
}

/** Whether a cleaned paste is only words, to go into the line at the caret rather than as blocks. */
export function isInline(frag: DocumentFragment): boolean {
  return ![...frag.childNodes].some((n) => n.nodeType === 1 && BLOCKS.has((n as Element).tagName.toLowerCase()));
}

/**
 * Clipboard HTML as a document to read, never run: what the frame's guard
 * would refuse to parse at all (a meta, a link, a script from the page it was
 * copied off) is cut out first, and a parse it still refuses comes back
 * undefined, for the paste to fall back to the plain text.
 */
export function parseClipboard(html: string): Document | undefined {
  const cut = html
    .replace(/<(script|style|template|noscript|iframe|object|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?([\w-]+:)?(link|meta|iframe|frame|frameset|object|embed|base|form|portal|fencedframe|script|style)(?![\w-])[^>]*>/gi, "")
    .replace(/xsl:/gi, "");
  try {
    return new DOMParser().parseFromString(cut, "text/html");
  } catch {
    return undefined;
  }
}
