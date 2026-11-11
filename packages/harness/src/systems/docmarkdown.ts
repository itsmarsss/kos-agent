import { parse, type DefaultTreeAdapterMap } from "parse5";

/**
 * A doc as Markdown, for the owner to take elsewhere: its article read as a
 * browser reads it (parse5) and written out as CommonMark with GitHub's
 * tables, task lists and footnotes.
 *
 * A doc is a small structure (artifacts.ts): a header (kicker, h1, lede,
 * byline), sections of headings and paragraphs, lists and checklists,
 * tables, figures with captions, pull quotes and callouts, code, and
 * `<span class="fn">` footnotes. Each has its Markdown; a drawing (an SVG or
 * a canvas chart) has none, so a figure of one keeps its caption alone.
 * Figures are numbered as the doc numbers them, notes as the doc does.
 */

type Node = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];
type Parent = DefaultTreeAdapterMap["parentNode"];

const isElement = (node: Node): node is Element => "tagName" in node;
const isText = (node: Node): node is DefaultTreeAdapterMap["textNode"] => node.nodeName === "#text";
const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const classes = (el: Element): string[] => (attr(el, "class") ?? "").split(/\s+/).filter(Boolean);
const hasClass = (el: Element, name: string): boolean => classes(el).includes(name);

/** What is read as running text rather than a block of its own. */
const INLINE = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "del", "dfn", "em", "i", "img", "ins", "kbd", "mark", "q", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
]);
/** Containers whose blocks are the doc's own: they add nothing of their own in Markdown. */
const WRAPPERS = new Set(["article", "header", "footer", "section", "div", "hgroup", "main", "nav", "picture"]);
/** What has no Markdown: a drawing, or what is not the doc's text. */
const SKIPPED = new Set(["svg", "canvas", "script", "style", "template", "button", "colgroup", "col"]);

interface Context {
  /** The footnotes met so far, in order, as Markdown. */
  notes: string[];
  figures: number;
}

/**
 * Markdown's own characters in running text, escaped so they read as
 * themselves: an underscore only where it could start or end emphasis, so
 * snake_case stays as written.
 */
const escapeText = (text: string): string => text.replace(/([\\`*[\]<])/g, "\\$1").replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace("_", "\\_"));

/** What would start a block at the head of a line (a heading, a quote, a list item, a rule), escaped; a digit cannot be, so a number's dot is. */
const escapeLineStart = (line: string): string =>
  line.replace(/^(\d+)([.)]\s)/, "$1\\$2").replace(/^(#{1,6}\s|>|[-+]\s|={3,}|-{3,})/, "\\$1");

/** A code span's fence: longer than any run of backticks inside it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The text a node holds, as written, for code. */
function rawText(node: Node): string {
  if (isText(node)) return node.value;
  if (!isElement(node)) return "";
  if (node.tagName === "br") return "\n";
  return node.childNodes.map(rawText).join("");
}

/** A mark around words, with any space at their edges kept outside it, where Markdown needs it. */
function wrap(mark: string, inner: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

/** A URL in a link or an image: spaces and parentheses would end it. */
const url = (href: string): string => href.trim().replace(/[\s()<>]/g, (c) => encodeURIComponent(c));

/** Running text as Markdown, its whitespace collapsed as a browser draws it. */
function inline(nodes: Node[], ctx: Context): string {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) {
      out += escapeText(node.value.replace(/\s+/g, " "));
      continue;
    }
    if (!isElement(node) || SKIPPED.has(node.tagName)) continue;
    const inner = (): string => inline(node.childNodes, ctx);
    switch (node.tagName) {
      case "strong":
      case "b":
        out += wrap("**", inner());
        break;
      case "em":
      case "i":
      case "cite":
      case "dfn":
        out += wrap("*", inner());
        break;
      case "del":
      case "s":
        out += wrap("~~", inner());
        break;
      case "code":
      case "kbd":
      case "samp":
        out += codeSpan(rawText(node).replace(/\s+/g, " "));
        break;
      case "br":
        out += "\\\n";
        break;
      case "a": {
        const text = inner().trim();
        const href = attr(node, "href");
        out += href ? `[${text || escapeText(href)}](${url(href)})` : text;
        break;
      }
      case "img":
        out += image(node);
        break;
      case "q":
        out += `“${inner()}”`;
        break;
      case "span":
        if (hasClass(node, "fn")) {
          ctx.notes.push(inline(node.childNodes, ctx).trim());
          out += `[^${ctx.notes.length}]`;
        } else out += inner();
        break;
      default:
        out += inner();
    }
  }
  return out;
}

function image(el: Element): string {
  const src = attr(el, "src");
  return src ? `![${escapeText(attr(el, "alt") ?? "")}](${url(src)})` : "";
}

/** A paragraph's text: trimmed, each line safe from being read as a block. */
function paragraph(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => escapeLineStart(line.trim()))
    .join("\n");
}

/** Every line of a block led by a prefix: a quote's "> ", a list item's indent. */
const prefixed = (text: string, first: string, rest = first): string =>
  text
    .split("\n")
    .map((line, i) => (i === 0 ? first : line ? rest : rest.trimEnd()) + line)
    .join("\n");

function list(el: Element, ctx: Context): string {
  const ordered = el.tagName === "ol";
  const checklist = hasClass(el, "checklist");
  let n = Number(attr(el, "start") ?? 1) || 1;
  const items: string[] = [];
  for (const li of el.childNodes) {
    if (!isElement(li) || li.tagName !== "li") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    const box = checklist ? (attr(li, "data-checked") === "true" ? "[x] " : "[ ] ") : "";
    const parts = blockParts(li.childNodes, ctx);
    // A line of text and the lists under it stay tight; more than one paragraph needs the blank lines.
    const tight = parts.filter((p) => !p.list).length <= 1;
    items.push(prefixed(box + parts.map((p) => p.md).join(tight ? "\n" : "\n\n"), marker, " ".repeat(marker.length)));
  }
  // A list whose items hold more than one block is loose: a blank line between them.
  const loose = items.some((item) => item.includes("\n\n"));
  return items.join(loose ? "\n\n" : "\n");
}

/** A table as GitHub's: its first row the head, each cell on one line, a spanned cell padded. */
function table(el: Element, ctx: Context): string {
  const rows: string[][] = [];
  const walk = (parent: Parent): void => {
    for (const child of parent.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === "tr") {
        const cells: string[] = [];
        for (const cell of child.childNodes) {
          if (!isElement(cell) || (cell.tagName !== "td" && cell.tagName !== "th")) continue;
          const text = inline(cell.childNodes, ctx).trim().replace(/\\\n/g, "<br>").replace(/\n/g, " ").replace(/\|/g, "\\|");
          cells.push(text);
          for (let span = Number(attr(cell, "colspan") ?? 1); span > 1; span--) cells.push("");
        }
        rows.push(cells);
      } else if (["thead", "tbody", "tfoot"].includes(child.tagName)) walk(child);
    }
  };
  walk(el);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]): string => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const caption = el.childNodes.find((c): c is Element => isElement(c) && c.tagName === "caption");
  return [
    ...(caption ? [`*${inline(caption.childNodes, ctx).trim()}*`, ""] : []),
    line(rows[0]!),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rows.slice(1).map(line),
  ].join("\n");
}

function code(el: Element): string {
  const inner = el.childNodes.find((c): c is Element => isElement(c) && c.tagName === "code");
  const lang = (inner ? classes(inner) : []).find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
  const text = rawText(el).replace(/\n$/, "");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** A figure: what it shows, then its caption, numbered as the doc numbers it. */
function figure(el: Element, ctx: Context): string {
  const caption = el.childNodes.find((c): c is Element => isElement(c) && c.tagName === "figcaption");
  const body = blocks(el.childNodes.filter((c) => c !== caption), ctx);
  if (caption) {
    const words = inline(caption.childNodes, ctx).trim();
    const label = hasClass(el, "unnumbered") ? "" : `Figure ${++ctx.figures}. `;
    body.push(`*${label}${words}*`);
  }
  return body.join("\n\n");
}

/** One block element as Markdown; empty when it has none. */
function block(el: Element, ctx: Context): string {
  const tag = el.tagName;
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${inline(el.childNodes, ctx).replace(/\\\n/g, " ").trim()}`;
  switch (tag) {
    case "p": {
      const text = paragraph(inline(el.childNodes, ctx));
      return text && hasClass(el, "byline") ? wrap("*", text) : text;
    }
    case "ul":
    case "ol":
      return list(el, ctx);
    case "blockquote":
    case "aside":
      return prefixed(blocks(el.childNodes, ctx).join("\n\n"), "> ");
    case "pre":
      return code(el);
    case "hr":
      return "---";
    case "table":
      return table(el, ctx);
    case "figure":
      return figure(el, ctx);
    case "details": {
      const summary = el.childNodes.find((c): c is Element => isElement(c) && c.tagName === "summary");
      const rest = blocks(el.childNodes.filter((c) => c !== summary), ctx);
      return [...(summary ? [`**${inline(summary.childNodes, ctx).trim()}**`] : []), ...rest].join("\n\n");
    }
    case "dl":
      return el.childNodes
        .filter(isElement)
        .map((d) => (d.tagName === "dt" ? `**${inline(d.childNodes, ctx).trim()}**` : paragraph(inline(d.childNodes, ctx))))
        .filter(Boolean)
        .join("\n\n");
    default:
      return blocks(el.childNodes, ctx).join("\n\n");
  }
}

/** A run of nodes as blocks, each marked when it is a list: loose running text between blocks becomes its own paragraph. */
function blockParts(nodes: Node[], ctx: Context): { md: string; list: boolean }[] {
  const out: { md: string; list: boolean }[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    const text = paragraph(inline(run, ctx));
    if (text) out.push({ md: text, list: false });
    run = [];
  };
  for (const node of nodes) {
    if (isText(node) || (isElement(node) && INLINE.has(node.tagName))) {
      run.push(node);
      continue;
    }
    flush();
    if (!isElement(node) || SKIPPED.has(node.tagName)) continue;
    const md = WRAPPERS.has(node.tagName) ? blocks(node.childNodes, ctx).join("\n\n") : block(node, ctx);
    if (md.trim()) out.push({ md, list: node.tagName === "ul" || node.tagName === "ol" });
  }
  flush();
  return out;
}

function blocks(nodes: Node[], ctx: Context): string[] {
  return blockParts(nodes, ctx).map((p) => p.md);
}

/** The first element under a node that passes. */
function find(node: Parent, test: (el: Element) => boolean): Element | undefined {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    if (test(child)) return child;
    const deeper = find(child, test);
    if (deeper) return deeper;
  }
  return undefined;
}

/** A doc's article as Markdown: its text, then its notes. The whole body when it has no article. */
export function docMarkdown(html: string): string {
  const document = parse(html);
  const root = find(document, (el) => el.tagName === "article" && el.attrs.some((a) => a.name === "data-doc")) ?? find(document, (el) => el.tagName === "body");
  const ctx: Context = { notes: [], figures: 0 };
  const body = root ? blocks(root.childNodes, ctx) : [];
  const notes = ctx.notes.map((note, i) => prefixed(note, `[^${i + 1}]: `, "    "));
  return `${[...body, ...(notes.length ? [notes.join("\n")] : [])].join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
