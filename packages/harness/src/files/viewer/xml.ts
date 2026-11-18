/**
 * Office XML, read into a tree.
 *
 * A Word, PowerPoint or OpenDocument file is a zip of XML that nests
 * (a run in a paragraph in a cell in a table), so the viewers walk a tree
 * rather than match patterns. This reads elements, attributes and text and
 * nothing else of XML: no DTD, no entity but the five and numeric
 * references, no external anything, so a hostile file has nothing to ask
 * for. Names keep their prefix ("w:p"), as the formats are written with
 * fixed prefixes in practice.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlChild[];
}

export type XmlChild = XmlNode | string;

/** Past this many elements a part is refused: a document has thousands, a bomb millions. */
export const XML_NODES_MAX = 2_000_000;

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#")) {
      const code = ref.startsWith("#x") ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[ref] ?? whole;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** The document's root element; an empty one for a part with none. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let count = 0;
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    const text = lt < 0 ? xml.slice(at) : xml.slice(at, lt);
    if (text && stack.length > 1) stack[stack.length - 1]!.children.push(decodeEntities(text));
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      at = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const data = xml.slice(lt + 9, end < 0 ? xml.length : end);
      if (stack.length > 1) stack[stack.length - 1]!.children.push(data);
      at = end < 0 ? xml.length : end + 3;
      continue;
    }
    // A declaration, a processing instruction or a doctype: skipped, never followed.
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt);
      at = end < 0 ? xml.length : end + 1;
      continue;
    }
    const gt = tagEnd(xml, lt);
    if (gt < 0) break;
    const body = xml.slice(lt + 1, gt);
    at = gt + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      // Close up to the matching element; a stray close tag is ignored.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const space = inner.search(/\s/);
    const name = space < 0 ? inner : inner.slice(0, space);
    const attrs: Record<string, string> = {};
    if (space >= 0) {
      for (const m of inner.slice(space).matchAll(ATTR)) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    if (++count > XML_NODES_MAX) throw new Error("the document is too large to show");
    const node: XmlNode = { name, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return (root.children.find((c): c is XmlNode => typeof c !== "string") ?? { name: "#empty", attrs: {}, children: [] });
}

/** Where a tag ends: its `>`, past any quoted attribute that holds one. */
function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

export const isNode = (c: XmlChild): c is XmlNode => typeof c !== "string";

/** The element children, optionally only those of one name. */
export function kids(node: XmlNode | undefined, name?: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c): c is XmlNode => isNode(c) && (name === undefined || c.name === name));
}

/** The first child of that name. */
export function kid(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c): c is XmlNode => isNode(c) && c.name === name);
}

/** Down a path of child names: `path(sp, "p:spPr", "a:xfrm")`. */
export function path(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  let at = node;
  for (const name of names) at = kid(at, name);
  return at;
}

/** Every descendant of that name, in document order, not looking inside a match. */
export function find(node: XmlNode | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      if (!isNode(c)) continue;
      if (c.name === name) out.push(c);
      else walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

/** All the text under a node. */
export function textOf(node: XmlNode | undefined): string {
  if (!node) return "";
  return node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}
