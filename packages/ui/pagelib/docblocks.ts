/**
 * A doc's blocks, as the editor moves them: what a block is, and the
 * operations on one (turn into, move, duplicate, delete, split, merge,
 * indent, a to-do's tick, a table's rows and columns). They work on the
 * article's own markup, so what they leave is the doc's stored form: a
 * paragraph, a heading, a list item, a quote, a callout (`aside.callout`), a
 * code block (`pre > code.language-*`), a toggle (`details > summary`), a
 * to-do (`ul.checklist > li[data-checked]`), a figure, a table, a divider.
 * Nothing here is the editor's own markup; what the runtime adds (a to-do's
 * box) is marked data-kos-gen and taken out before a save (doc.ts).
 *
 * A block is a list item, or an element whose parent holds blocks (the
 * article, its header, a section, a div of blocks). A quote, a callout, a
 * toggle, a figure and a table are one block each, whatever they hold.
 */

const GEN = "data-kos-gen";

/** What a block can be turned into. */
export type BlockKind = "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "todo" | "quote" | "callout" | "code" | "toggle";

export const TURN_INTO: readonly { kind: BlockKind; label: string }[] = [
  { kind: "p", label: "Text" },
  { kind: "h1", label: "Heading 1" },
  { kind: "h2", label: "Heading 2" },
  { kind: "h3", label: "Heading 3" },
  { kind: "ul", label: "Bulleted list" },
  { kind: "ol", label: "Numbered list" },
  { kind: "todo", label: "To-do list" },
  { kind: "toggle", label: "Toggle" },
  { kind: "quote", label: "Quote" },
  { kind: "callout", label: "Callout" },
  { kind: "code", label: "Code" },
];

const CONTAINERS = new Set(["ARTICLE", "HEADER", "SECTION", "FOOTER", "HGROUP", "MAIN", "NAV"]);
const LISTS = new Set(["UL", "OL"]);
/** Blocks inside a callout, a toggle's body or a quote of paragraphs: Enter and Backspace keep to them. */
const WRAPPERS = "aside, details, blockquote";
const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "BLOCKQUOTE", "ASIDE", "DETAILS", "FIGURE", "TABLE", "HR", "DIV", "SECTION", "HEADER", "FOOTER", "DL"]);

const isGen = (node: Node): boolean => node instanceof Element && node.hasAttribute(GEN) && node.getAttribute(GEN) !== "wrap";
const isList = (node: Node | null | undefined): node is HTMLUListElement | HTMLOListElement => !!node && node instanceof Element && LISTS.has(node.tagName);
const doc = (node: Node): Document => node.ownerDocument ?? document;

/** A div is a container when it holds blocks; one of text is a block itself. The runtime's table wrapper is the table's block. */
function isContainer(el: Element): boolean {
  if (CONTAINERS.has(el.tagName)) return true;
  if (el.tagName !== "DIV" || el.hasAttribute(GEN)) return false;
  return [...el.children].some((c) => BLOCK_TAGS.has(c.tagName) && !isGen(c));
}

/** The kind of list a list is, by its tag and whether it is a checklist. */
const listType = (list: Element): string => list.tagName + (list.classList.contains("checklist") ? ".checklist" : "");

/** Whether an element is one of the article's blocks. */
export function isBlock(article: Element, el: Element): boolean {
  if (!(el instanceof HTMLElement) || el === article || !article.contains(el) || isGen(el)) return false;
  if (el.tagName === "LI") return isList(el.parentElement) && blockParentOk(article, el.parentElement);
  if (isList(el) || isContainer(el)) return false;
  const parent = el.parentElement;
  return !!parent && (parent === article || (article.contains(parent) && isContainer(parent)));
}

/** A list holds blocks when it sits among blocks or in a list item that is one. */
function blockParentOk(article: Element, list: Element): boolean {
  const parent = list.parentElement;
  if (!parent) return false;
  if (parent === article || isContainer(parent)) return parent === article || article.contains(parent);
  return parent.tagName === "LI" && isBlock(article, parent);
}

/** The block holding a node, if it is in the article. */
export function blockOf(article: Element, node: Node | null): HTMLElement | undefined {
  for (let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null); el && el !== article; el = el.parentElement) {
    if (isBlock(article, el)) return el as HTMLElement;
  }
  return undefined;
}

/** Every block of the article in reading order, nested items after their parent. */
export function allBlocks(article: Element): HTMLElement[] {
  return [...article.querySelectorAll<HTMLElement>("*")].filter((el) => isBlock(article, el));
}

/** The container a block sits among its peers in: a list item's is its list's. */
function homeOf(article: Element, block: Element): Element {
  let el: Element = block;
  while (el.tagName === "LI" && el.parentElement) {
    const list = el.parentElement;
    const up = list.parentElement!;
    if (up.tagName === "LI") el = up;
    else return up;
  }
  return el.parentElement ?? article;
}

/** The blocks that share a block's container, in order: what moving up and down steps over. */
function peersOf(article: Element, block: Element): HTMLElement[] {
  const home = homeOf(article, block);
  const nested = block.tagName === "LI" && block.parentElement?.parentElement?.tagName === "LI";
  if (nested) return [...block.parentElement!.children].filter((c): c is HTMLElement => c.tagName === "LI");
  return allBlocks(article).filter((b) => homeOf(article, b) === home && !(b.tagName === "LI" && b.parentElement?.parentElement?.tagName === "LI"));
}

/** A fresh list like another: its tag and its checklist class, no items. */
function listLike(list: Element): HTMLElement {
  const fresh = doc(list).createElement(list.tagName.toLowerCase());
  if (list.classList.contains("checklist")) fresh.className = "checklist";
  return fresh;
}

/** Take an item out into a list of its own, its earlier and later siblings left in lists either side; the list it is now alone in. */
function isolate(li: HTMLElement): HTMLElement {
  const list = li.parentElement!;
  const after = [...list.children].slice([...list.children].indexOf(li) + 1);
  if (after.length) {
    const tail = listLike(list);
    tail.append(...after);
    list.after(tail);
  }
  if (li.previousElementSibling) {
    const alone = listLike(list);
    list.after(alone);
    alone.append(li);
    return alone;
  }
  return list;
}

/** Join lists of one kind that now sit side by side, and drop lists left empty. */
function tidyLists(around: (Element | null | undefined)[]): void {
  for (const el of around) {
    if (!el?.isConnected) continue;
    for (const list of [el, el.previousElementSibling, el.nextElementSibling]) {
      if (!isList(list) || !list.isConnected) continue;
      if (!list.querySelector(":scope > li")) {
        list.remove();
        continue;
      }
      const next = list.nextElementSibling;
      if (isList(next) && listType(next) === listType(list) && !list.hasAttribute("id") && !next.hasAttribute("id")) {
        list.append(...next.childNodes);
        next.remove();
      }
      const prev = list.previousElementSibling;
      if (isList(prev) && listType(prev) === listType(list) && !list.hasAttribute("id") && !prev.hasAttribute("id")) {
        prev.append(...list.childNodes);
        list.remove();
      }
    }
  }
}

/** The children of a block that are its own words: a list item's, without the lists nested in it; a code block's, as text. */
function inlineOf(block: HTMLElement): Node[] {
  if (block.tagName === "LI") return [...block.childNodes].filter((n) => !isList(n) && !isGen(n));
  if (block.tagName === "PRE") return [doc(block).createTextNode(block.textContent ?? "")];
  if (block.matches("aside, details, blockquote")) {
    const kids = [...block.childNodes].filter((n) => !isGen(n) && !(n instanceof Text && !n.data.trim()));
    // One paragraph, or the summary and nothing written under it, read as that line.
    const first = kids.find((n) => n instanceof Element && (n.tagName === "P" || n.tagName === "SUMMARY"));
    const rest = kids.filter((n) => n !== first && !(n instanceof Element && n.tagName === "P" && !n.textContent?.trim() && !n.querySelector("img")));
    if (first && !rest.length) return [...first.childNodes];
    if (!kids.some((n) => n instanceof Element && BLOCK_TAGS.has(n.tagName))) return kids;
    // Several blocks: none of them is the wrapper's one line (turnInto takes them apart).
    return [];
  }
  if (block.tagName === "FIGURE" || block.tagName === "TABLE" || block.tagName === "HR" || block.hasAttribute(GEN)) return [];
  return [...block.childNodes].filter((n) => !isGen(n));
}

/** Whether a block's own words are empty: no text and no picture. */
export function isEmpty(block: Element): boolean {
  const own = block.tagName === "LI" ? inlineOf(block as HTMLElement) : [...block.childNodes];
  return own.every((n) => (n instanceof Text ? !n.data.replace(/​/g, "") : n instanceof Element ? n.tagName === "BR" || isGen(n) || (!n.querySelector("img") && n.tagName !== "IMG" && isEmpty(n)) : true));
}

function make(owner: Document, tag: string, children: Node[] = []): HTMLElement {
  const el = owner.createElement(tag);
  el.append(...children);
  if (!el.childNodes.length || isEmpty(el)) el.replaceChildren(owner.createElement("br"));
  return el;
}

/** The block a kind of text is held in, with these words. */
function shell(owner: Document, kind: BlockKind, words: Node[]): { block: HTMLElement; holder: HTMLElement } {
  switch (kind) {
    case "ul":
    case "ol":
    case "todo": {
      const list = owner.createElement(kind === "todo" ? "ul" : kind);
      if (kind === "todo") list.className = "checklist";
      const li = make(owner, "li", words);
      if (kind === "todo") li.setAttribute("data-checked", "false");
      list.append(li);
      return { block: list, holder: li };
    }
    case "quote": {
      const q = make(owner, "blockquote", words);
      return { block: q, holder: q };
    }
    case "callout": {
      const aside = owner.createElement("aside");
      aside.className = "callout";
      const p = make(owner, "p", words);
      aside.append(p);
      return { block: aside, holder: p };
    }
    case "toggle": {
      const details = owner.createElement("details");
      details.setAttribute("open", "");
      const summary = make(owner, "summary", words);
      details.append(summary, make(owner, "p"));
      return { block: details, holder: summary };
    }
    case "code": {
      const pre = owner.createElement("pre");
      const code = owner.createElement("code");
      const text = words.map((n) => n.textContent ?? "").join("");
      code.textContent = text;
      if (!text) code.append(owner.createElement("br"));
      pre.append(code);
      return { block: pre, holder: code };
    }
    default: {
      const el = make(owner, kind, words);
      return { block: el, holder: el };
    }
  }
}

/** What kind a block is, for the menu to tick and Turn into to skip. */
export function kindOf(block: Element): BlockKind | undefined {
  const tag = block.tagName;
  if (tag === "LI") return block.parentElement?.classList.contains("checklist") ? "todo" : block.parentElement?.tagName === "OL" ? "ol" : "ul";
  if (tag === "P") return "p";
  if (tag === "H1" || tag === "H2" || tag === "H3") return tag.toLowerCase() as BlockKind;
  if (tag === "BLOCKQUOTE") return "quote";
  if (tag === "ASIDE" && block.classList.contains("callout")) return "callout";
  if (tag === "PRE") return "code";
  if (tag === "DETAILS") return "toggle";
  return undefined;
}

/**
 * Turn a block into another kind, keeping its words and its id: a list item
 * leaves its list (or joins another), a paragraph joins a list beside it of
 * the same kind. The element the words are now in.
 */
export function turnInto(article: Element, block: HTMLElement, kind: BlockKind): HTMLElement {
  const owner = doc(block);
  if (kindOf(block) === kind) return holderOf(block);
  // A list item to another kind of list: its list changes, the item stays.
  if (block.tagName === "LI" && (kind === "ul" || kind === "ol" || kind === "todo")) {
    const list = isolate(block);
    const next = owner.createElement(kind === "todo" ? "ul" : kind);
    if (kind === "todo") next.className = "checklist";
    list.replaceWith(next);
    next.append(...list.childNodes);
    if (kind === "todo") block.setAttribute("data-checked", block.getAttribute("data-checked") === "true" ? "true" : "false");
    else block.removeAttribute("data-checked");
    tidyLists([next]);
    return block;
  }
  const words = inlineOf(block);
  const { block: made, holder } = shell(owner, kind, words);
  if (block.id) made.id = block.id;
  for (const c of block.classList) if (["doc-wide", "doc-full"].includes(c)) made.classList.add(c);
  if (block.tagName === "LI") {
    const nested = [...block.children].filter(isList);
    const list = isolate(block);
    list.replaceWith(made);
    // What was nested under the item follows it, as a list of its own.
    made.after(...nested);
    tidyLists([made, ...nested]);
  } else {
    // A wrapper of several blocks: its first becomes the kind, the rest follow it.
    const kids = block.matches(WRAPPERS) && words.length === 0 ? [...block.children].filter((c) => !isGen(c)) : [];
    block.replaceWith(made);
    if (kids.length) {
      const [first, ...rest] = kids as HTMLElement[];
      holder.replaceChildren(...inlineOf(first!));
      if (!holder.childNodes.length) holder.append(owner.createElement("br"));
      made.after(...rest);
    }
    tidyLists([made]);
  }
  return holder;
}

/** Where the words of a block are typed: a callout's paragraph, a toggle's summary, a code block's code. */
export function holderOf(block: HTMLElement): HTMLElement {
  if (block.tagName === "ASIDE") return block.querySelector<HTMLElement>(":scope > p") ?? block;
  if (block.tagName === "DETAILS") return block.querySelector<HTMLElement>(":scope > summary") ?? block;
  if (block.tagName === "PRE") return block.querySelector<HTMLElement>(":scope > code") ?? block;
  return block;
}

/**
 * Put a block before or after another. A list item stays a list item: among
 * a list's items it joins that list, elsewhere it takes a list of its own
 * kind; anything else put among a list's items splits the list there.
 */
export function moveTo(article: Element, block: HTMLElement, target: HTMLElement, where: "before" | "after"): void {
  if (block === target || block.contains(target) || target.contains(block)) return;
  const was = [block.parentElement, block.previousElementSibling, block.nextElementSibling];
  let node: HTMLElement = block;
  if (block.tagName === "LI" && target.tagName !== "LI") {
    node = isolate(block);
  } else if (block.tagName !== "LI" && target.tagName === "LI") {
    const list = target.parentElement!;
    const items = [...list.children];
    const at = items.indexOf(target) + (where === "after" ? 1 : 0);
    const tail = items.slice(at);
    if (at === 0) {
      list.before(block);
      tidyLists(was);
      return;
    }
    if (tail.length) {
      const rest = listLike(list);
      rest.append(...tail);
      list.after(rest);
    }
    list.after(block);
    tidyLists([...was, block]);
    return;
  }
  if (where === "before") target.before(node);
  else target.after(node);
  if (node.tagName === "LI" && node.parentElement && listType(node.parentElement) !== (block.parentElement ? listType(block.parentElement) : "")) {
    // An item moved into a list of another kind takes that kind.
    if (node.parentElement.classList.contains("checklist")) node.setAttribute("data-checked", node.getAttribute("data-checked") ?? "false");
    else node.removeAttribute("data-checked");
  }
  tidyLists([...was, node]);
}

/** Move a block one place up or down among its peers; false at the end. */
export function moveBlock(article: Element, block: HTMLElement, dir: -1 | 1): boolean {
  const peers = peersOf(article, block);
  const at = peers.indexOf(block);
  const other = peers[at + dir];
  if (!other) return false;
  moveTo(article, block, other, dir < 0 ? "before" : "after");
  return true;
}

/** Move several blocks (in reading order) one place together; false when the first or last is at the end. */
export function moveBlocks(article: Element, blocks: HTMLElement[], dir: -1 | 1): boolean {
  if (!blocks.length) return false;
  const order = dir < 0 ? blocks : [...blocks].reverse();
  const edge = order[0]!;
  const peers = peersOf(article, edge);
  const other = peers[peers.indexOf(edge) + dir];
  if (!other || blocks.includes(other)) return false;
  // The one past the edge goes to the far side of the run.
  moveTo(article, other, dir < 0 ? blocks[blocks.length - 1]! : blocks[0]!, dir < 0 ? "after" : "before");
  return true;
}

/** A copy of a block after it, without its ids. The copy. */
export function duplicate(block: HTMLElement): HTMLElement {
  const copy = block.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
  block.after(copy);
  return copy;
}

/** Take blocks out; the block to put the caret in after, made if none is left. */
export function removeBlocks(article: Element, blocks: HTMLElement[]): HTMLElement {
  const last = blocks[blocks.length - 1]!;
  const all = allBlocks(article);
  const after = all.slice(all.indexOf(last) + 1).find((b) => !blocks.some((x) => x.contains(b)));
  const before = all.slice(0, all.indexOf(blocks[0]!)).reverse().find((b) => !blocks.some((x) => x.contains(b)));
  const around: Element[] = [];
  for (const b of blocks) {
    around.push(...[b.parentElement, b.previousElementSibling, b.nextElementSibling].filter((x): x is Element => !!x));
    b.remove();
  }
  tidyLists(around);
  const next = (after?.isConnected ? after : undefined) ?? (before?.isConnected ? before : undefined);
  if (next) return next;
  const p = make(doc(article), "p");
  article.append(p);
  return p;
}

/** Nest a list item under the one before it; false for the first item. */
export function indent(li: HTMLElement): boolean {
  const prev = li.previousElementSibling;
  if (li.tagName !== "LI" || prev?.tagName !== "LI") return false;
  const list = li.parentElement!;
  let sub = [...prev.children].reverse().find((c) => isList(c) && listType(c) === listType(list));
  if (!sub) {
    sub = listLike(list);
    prev.append(sub);
  }
  sub.append(li);
  // Its own nested items join the list it is now in, after it.
  const own = [...li.children].find((c) => isList(c) && listType(c) === listType(list));
  if (own && own.previousElementSibling === null && li.childNodes.length === 1) li.replaceWith(...own.childNodes);
  return true;
}

/** Bring a nested list item out to its parent's level, the items after it nested under it; false at the top level. */
export function outdent(li: HTMLElement): boolean {
  const list = li.parentElement;
  const parent = list?.parentElement;
  if (li.tagName !== "LI" || !list || parent?.tagName !== "LI") return false;
  const after = [...list.children].slice([...list.children].indexOf(li) + 1);
  if (after.length) {
    let sub = [...li.children].find((c) => isList(c) && listType(c) === listType(list));
    if (!sub) {
      sub = listLike(list);
      li.append(sub);
    }
    sub.append(...after);
  }
  parent.after(li);
  if (!list.children.length) list.remove();
  if (parent.parentElement?.classList.contains("checklist")) li.setAttribute("data-checked", li.getAttribute("data-checked") ?? "false");
  return true;
}

/** Tick a to-do or take its tick away; whether it is now done. */
export function toggleTodo(li: Element): boolean {
  const done = li.getAttribute("data-checked") !== "true";
  li.setAttribute("data-checked", String(done));
  return done;
}

/** A place in the document: a node and an offset into it. */
export interface Caret {
  node: Node;
  offset: number;
}

/** Whether nothing of a block's own words comes before the caret. */
export function atStart(block: HTMLElement, caret: Caret): boolean {
  const range = doc(block).createRange();
  range.setStart(holderOf(block), 0);
  try {
    range.setEnd(caret.node, caret.offset);
  } catch {
    return false;
  }
  const before = range.cloneContents();
  before.querySelectorAll(`[${GEN}]:not([${GEN}="wrap"])`).forEach((n) => n.remove());
  return !(before.textContent ?? "").replace(/​/g, "") && !before.querySelector("img");
}

/** Whether nothing of a block's own words comes after the caret. */
export function atEnd(block: HTMLElement, caret: Caret): boolean {
  const holder = holderOf(block);
  const range = doc(block).createRange();
  range.setStart(caret.node, caret.offset);
  const nested = block.tagName === "LI" ? [...block.children].find(isList) : undefined;
  if (nested) range.setEndBefore(nested);
  else range.setEnd(holder, holder.childNodes.length);
  const after = range.cloneContents();
  return !(after.textContent ?? "").replace(/​/g, "") && !after.querySelector("img");
}

const startOf = (el: Node): Caret => ({ node: el, offset: 0 });

/** Where the caret goes at the end of a block's words. */
export function endOf(block: HTMLElement): Caret {
  const holder = holderOf(block);
  const nested = block.tagName === "LI" ? [...block.childNodes].findIndex((n) => isList(n)) : -1;
  const kids = holder.childNodes;
  let at = nested >= 0 ? nested : kids.length;
  // Before a closing <br>, which only holds an empty line open.
  if (at > 0 && kids[at - 1] instanceof Element && (kids[at - 1] as Element).tagName === "BR") at -= 1;
  return { node: holder, offset: at };
}

/**
 * Enter: split a block at the caret into two of its kind, or into a
 * paragraph after a heading or a quote's end; an empty list item leaves its
 * list (or its nesting), an empty last paragraph of a callout or toggle
 * leaves it. Where the caret goes, or undefined to leave it to the browser.
 */
export function splitBlock(article: Element, block: HTMLElement, caret: Caret): Caret | undefined {
  const owner = doc(block);
  // Inside a callout, a toggle or a quote of paragraphs: its paragraphs split there; an empty last one steps out.
  const inner = caretBlockIn(block, caret);
  if (block.tagName === "DETAILS" && inner?.tagName === "SUMMARY") {
    const details = block as HTMLDetailsElement;
    details.open = true;
    const tail = extractAfter(inner, caret);
    // The empty line a new toggle opens on is the one to go to, when nothing follows the caret.
    const next = inner.nextElementSibling;
    if (!tail && next instanceof HTMLElement && next.tagName === "P" && isEmpty(next)) return startOf(next);
    const p = make(owner, "p", tail ? [...tail.childNodes] : []);
    inner.after(p);
    ensureLine(inner);
    return startOf(p);
  }
  if (inner && inner !== block && inner.tagName === "P") {
    if (isEmpty(inner) && inner === lastOwn(block) && ownBlocks(block).length > 1) {
      block.after(inner);
      return startOf(inner);
    }
    const tail = extractAfter(inner, caret);
    const p = make(owner, "p", tail ? [...tail.childNodes] : []);
    inner.after(p);
    ensureLine(inner);
    return startOf(p);
  }
  if (block.tagName === "LI") {
    if (isEmpty(block)) {
      if (outdent(block)) return startOf(holderOf(block));
      const p = turnInto(article, block, "p");
      return startOf(p);
    }
    const tail = extractAfter(block, caret);
    const li = make(owner, "li", tail ? [...tail.childNodes] : []);
    if (block.parentElement?.classList.contains("checklist")) li.setAttribute("data-checked", "false");
    // Items nested under it stay with the words before the caret, unless the caret was at the very start.
    block.after(li);
    ensureLine(block);
    return startOf(li);
  }
  if (/^(P|H[1-6]|BLOCKQUOTE)$/.test(block.tagName)) {
    const end = atEnd(block, caret);
    const tail = extractAfter(block, caret);
    const tag = end || block.tagName === "P" ? "p" : block.tagName.toLowerCase();
    const next = make(owner, tag, tail ? [...tail.childNodes] : []);
    block.after(next);
    ensureLine(block);
    return startOf(next);
  }
  if (block.tagName === "FIGURE") {
    const p = make(owner, "p");
    block.after(p);
    return startOf(p);
  }
  return undefined;
}

/** The paragraph or summary inside a wrapper block the caret is in. */
function caretBlockIn(block: HTMLElement, caret: Caret): HTMLElement | undefined {
  if (!block.matches(WRAPPERS)) return undefined;
  for (let el: Element | null = caret.node instanceof Element ? caret.node : caret.node.parentElement; el && el !== block; el = el.parentElement) {
    if (el.parentElement === block && (el.tagName === "P" || el.tagName === "SUMMARY")) return el as HTMLElement;
  }
  return undefined;
}

const ownBlocks = (block: Element): Element[] => [...block.children].filter((c) => !isGen(c));
const lastOwn = (block: Element): Element | undefined => ownBlocks(block).at(-1);

/** Take what follows the caret in a block's own words out, as a fragment; undefined when nothing does. */
function extractAfter(block: HTMLElement, caret: Caret): DocumentFragment | undefined {
  const holder = holderOf(block);
  const range = doc(block).createRange();
  range.setStart(caret.node, caret.offset);
  const nested = block.tagName === "LI" ? [...block.children].find(isList) : undefined;
  if (nested) range.setEndBefore(nested);
  else range.setEnd(holder, holder.childNodes.length);
  if (range.collapsed) return undefined;
  const frag = range.extractContents();
  frag.querySelectorAll(`[${GEN}]:not([${GEN}="wrap"])`).forEach((n) => n.remove());
  return (frag.textContent ?? "").replace(/\u200b/g, "") || frag.querySelector("img") ? frag : undefined;
}

/** An emptied block keeps a line to type on. */
function ensureLine(block: HTMLElement): void {
  if (!isEmpty(block)) return;
  const holder = holderOf(block);
  // What a split left empty (a bold with no words) goes with the words.
  for (const n of [...holder.childNodes]) if (!isList(n) && !isGen(n)) n.remove();
  const nested = block.tagName === "LI" ? [...block.children].find(isList) : undefined;
  const br = doc(block).createElement("br");
  if (nested) nested.before(br);
  else holder.append(br);
}

/**
 * Backspace at the start of a block: a heading, quote, list item or code
 * block first becomes a paragraph (a nested item comes out a level first);
 * a paragraph joins the block before it, or takes away a divider before it.
 * Where the caret goes, "select" when the block before is one to select
 * rather than join (a figure, a table), or undefined to leave it to the
 * browser.
 */
export function mergeBack(article: Element, block: HTMLElement, caret: Caret): Caret | "select" | undefined {
  const inner = caretBlockIn(block, caret);
  if (inner && inner !== block) {
    // A callout's or toggle's first line: the whole block becomes text.
    if (inner === ownBlocks(block)[0]) {
      const p = turnInto(article, block, "p");
      return startOf(p);
    }
    const prev = inner.previousElementSibling as HTMLElement | null;
    if (!prev) return undefined;
    return join(prev, inner);
  }
  if (block.tagName === "LI" && outdent(block)) return startOf(holderOf(block));
  if (block.tagName !== "P") {
    if (!kindOf(block)) return undefined;
    const p = turnInto(article, block, "p");
    return startOf(p);
  }
  const peers = allBlocks(article);
  const prev = peers.slice(0, peers.indexOf(block)).reverse().find((b) => !b.contains(block));
  if (!prev) return undefined;
  if (prev.tagName === "HR") {
    prev.remove();
    return caret;
  }
  if (prev.matches("figure, table") || prev.hasAttribute(GEN) || (prev.matches(WRAPPERS) && !holderOfLast(prev))) {
    // An empty line before a figure goes; either way the figure is picked, for Backspace again to delete it.
    if (isEmpty(block)) removeBlocks(article, [block]);
    return "select";
  }
  const into = prev.matches(WRAPPERS) ? holderOfLast(prev)! : prev;
  return join(into, block);
}

/** The last paragraph of a callout, toggle or quote, to join a line onto. */
function holderOfLast(wrapper: HTMLElement): HTMLElement | undefined {
  const last = lastOwn(wrapper);
  if (last instanceof HTMLElement && /^(P|SUMMARY)$/.test(last.tagName)) return last;
  if (!wrapper.querySelector(":scope > *:not(br)")) return wrapper;
  return undefined;
}

/** Put a block's words at the end of another's, the block gone; the caret where they meet. */
function join(into: HTMLElement, from: HTMLElement): Caret {
  const at = endOf(into);
  const words = inlineOf(from).filter((n) => !(n instanceof Element && n.tagName === "BR" && isEmpty(from)));
  const holder = at.node as Element;
  // A <br> that held the line open goes once there are words after it.
  const kids = [...holder.childNodes];
  const br = kids[at.offset];
  if (br instanceof Element && br.tagName === "BR" && words.length) br.remove();
  const ref = holder.childNodes[at.offset] ?? null;
  for (const w of words) holder.insertBefore(w, ref);
  const nested = from.tagName === "LI" ? [...from.children].filter(isList) : [];
  const around = [from.parentElement, from.previousElementSibling, from.nextElementSibling];
  if (nested.length) from.after(...nested);
  from.remove();
  tidyLists(around);
  return at;
}

/* ---------------------------- tables ---------------------------- */

/** A row or a column added beside a cell's, or taken out; the cell to go to after. */
export function tableEdit(cell: HTMLTableCellElement, op: "row-after" | "row-before" | "col-after" | "col-before" | "row-remove" | "col-remove"): HTMLTableCellElement | undefined {
  const table = cell.closest("table");
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!table || !row) return undefined;
  const owner = doc(cell);
  const rows = [...table.rows];
  const col = cell.cellIndex;
  if (op === "row-after" || op === "row-before") {
    const inHead = row.parentElement?.tagName === "THEAD";
    const fresh = owner.createElement("tr");
    const width = Math.max(...rows.map((r) => r.cells.length));
    for (let i = 0; i < width; i++) fresh.append(make(owner, "td"));
    if (inHead) {
      // A row below the header row is the body's first.
      let body = table.tBodies[0];
      if (!body) table.append((body = owner.createElement("tbody")));
      body.prepend(fresh);
    } else if (op === "row-after") row.after(fresh);
    else row.before(fresh);
    return fresh.cells[Math.min(col, fresh.cells.length - 1)];
  }
  if (op === "col-after" || op === "col-before") {
    let mine: HTMLTableCellElement | undefined;
    for (const r of rows) {
      const ref = r.cells[col];
      const fresh = make(owner, r.parentElement?.tagName === "THEAD" ? "th" : "td") as HTMLTableCellElement;
      if (!ref) r.append(fresh);
      else if (op === "col-after") ref.after(fresh);
      else ref.before(fresh);
      if (r === row) mine = fresh;
    }
    return mine;
  }
  if (op === "row-remove") {
    const body = rows.filter((r) => r.parentElement?.tagName !== "THEAD");
    if (row.parentElement?.tagName === "THEAD" || body.length <= 1) return undefined;
    const next = (row.nextElementSibling ?? row.previousElementSibling) as HTMLTableRowElement | null;
    row.remove();
    return next?.cells[Math.min(col, next.cells.length - 1)];
  }
  if (Math.max(...rows.map((r) => r.cells.length)) <= 1) return undefined;
  for (const r of rows) r.cells[col]?.remove();
  return row.cells[Math.max(0, col - 1)];
}

/** A new table, two columns of header and two rows. */
export function newTable(owner: Document): HTMLTableElement {
  const table = owner.createElement("table");
  const head = owner.createElement("thead");
  const tr = owner.createElement("tr");
  for (const label of ["Column", "Column"]) tr.append(Object.assign(owner.createElement("th"), { textContent: label }));
  head.append(tr);
  const body = owner.createElement("tbody");
  for (let r = 0; r < 2; r++) {
    const row = owner.createElement("tr");
    row.append(make(owner, "td"), make(owner, "td"));
    body.append(row);
  }
  table.append(head, body);
  return table;
}

/* ---------------------------- to-do boxes ---------------------------- */

/**
 * Each to-do gets a box to tick, the runtime's own (data-kos-gen), so a
 * reader with a keyboard or a screen reader can tick it as with a pointer;
 * the stored item keeps only data-checked.
 */
let todos = 0;
export function ensureTodoBoxes(root: Element): void {
  const owner = doc(root);
  for (const li of root.querySelectorAll<HTMLElement>("ul.checklist > li")) {
    const done = li.getAttribute("data-checked") === "true";
    if (!li.hasAttribute("data-checked")) li.setAttribute("data-checked", "false");
    let box = li.firstElementChild?.classList.contains("todo-box") ? (li.firstElementChild as HTMLElement) : undefined;
    for (const stray of li.querySelectorAll(":scope > .todo-box")) if (stray !== box) stray.remove();
    if (!box) {
      box = owner.createElement("button");
      box.setAttribute(GEN, "");
      box.setAttribute("type", "button");
      box.className = "todo-box";
      box.setAttribute("role", "checkbox");
      box.setAttribute("contenteditable", "false");
      li.prepend(box);
    }
    box.setAttribute("aria-checked", String(done));
    // Named by the item's own words, not the items nested under it: through the item itself (an id of the runtime's, data-kos-gen-id, taken off on save, when it has none), or its words when it holds a list.
    if (li.querySelector(":scope > ul, :scope > ol")) {
      box.removeAttribute("aria-labelledby");
      box.setAttribute("aria-label", inlineOf(li).map((n) => n.textContent ?? "").join("").replace(/\s+/g, " ").trim() || "To-do");
    } else {
      if (!li.id) {
        li.id = `kos-todo-${++todos}`;
        li.setAttribute("data-kos-gen-id", "");
      }
      box.setAttribute("aria-labelledby", li.id);
      box.removeAttribute("aria-label");
    }
  }
  // A box whose item stopped being a to-do goes.
  for (const box of root.querySelectorAll(".todo-box")) if (!box.parentElement?.matches("ul.checklist > li")) box.remove();
}

/* ---------------------------- tidying ---------------------------- */

/**
 * What the browser's own editing leaves that a doc is not made of, made
 * the doc's: <strike> as <s>, <font> unwrapped, a to-do without its state
 * given one.
 */
export function normalise(article: Element): void {
  const owner = doc(article);
  for (const strike of article.querySelectorAll("strike")) {
    const s = owner.createElement("s");
    s.append(...strike.childNodes);
    strike.replaceWith(s);
  }
  for (const font of article.querySelectorAll("font")) font.replaceWith(...font.childNodes);
  // The <br> that held an empty line open, left behind once words were typed before it; a line break typed at the end is two.
  for (const block of article.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, summary, blockquote, figcaption, td, th")) {
    const last = [...block.childNodes].filter((n) => !(n instanceof Text && !n.data) && !isList(n)).at(-1);
    if (!(last instanceof Element) || last.tagName !== "BR") continue;
    const before = last.previousSibling;
    if (before && !(before instanceof Element && before.tagName === "BR") && !isEmpty(block)) last.remove();
  }
  for (const li of article.querySelectorAll("ul.checklist > li:not([data-checked])")) li.setAttribute("data-checked", "false");
  for (const li of article.querySelectorAll("ul:not(.checklist) > li[data-checked], ol > li[data-checked]")) li.removeAttribute("data-checked");
}
