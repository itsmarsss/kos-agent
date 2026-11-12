/**
 * Editing a doc where it is drawn, block by block, the way Notion or a
 * document editor does. Beside the block under the pointer, a "+" adds a
 * block below through the "/" menu, and a handle drags the block to another
 * place or, pressed, opens its menu (turn into, colour, duplicate, move,
 * copy a link to it, delete). The "/" menu inserts any block; a bar over a
 * selection formats it (bold, italic, underline, strike, code, a link, a
 * colour or a highlight) or turns the blocks it touches into another kind;
 * markdown typed at a line's start makes a block. Enter splits a block and
 * Backspace at its start joins it to the one before; Tab nests a list item;
 * Cmd+Shift+Up and Down move a block, Cmd+D duplicates it, and Escape
 * selects it, after which the arrows, Shift, Delete and the same keys act on
 * the blocks selected. A paste keeps the structure of what was copied, as
 * the doc's own blocks. Undo covers all of it (dochistory.ts), and the doc
 * saves itself a moment after the owner stops.
 *
 * It runs inside the doc's frame, on the article's own markup, not on a
 * model of its own: whatever the agent wrote (a pull quote, a footnote, a
 * class) is kept as written, and every block operation (docblocks.ts) leaves
 * the doc's stored form. What the editor draws (the handle, its menus, the
 * bars, the marks over selected blocks) lives outside the article; what it
 * puts inside (a to-do's box, the line's placeholder) is the runtime's and
 * is taken out before a save. Nothing leaves the frame but window.kos:
 * kos.save, and kos.mention for an @ mention, which the dashboard answers
 * from its own picker with the one artifact the owner picked.
 */

import { ARTIFACT_ID_RE, DOC_EDIT_MAX } from "@kos/shared/artifacts";

import {
  allBlocks, atEnd, atStart, blockOf, duplicate, ensureTodoBoxes, holderOf, indent, isEmpty, kindOf, mergeBack, moveBlocks, moveTo, newTable,
  normalise, outdent, removeBlocks, splitBlock, tableEdit, toggleTodo, turnInto, TURN_INTO, type BlockKind, type Caret,
} from "./docblocks.js";
import { History } from "./dochistory.js";
import { IMAGE_MAX, cleanPaste, isInline, parseClipboard } from "./docpaste.js";
import { Menu, icon, type IconName, type MenuItem } from "./docui.js";
import { el, kos, reason } from "./runtime.js";

/** A block a line can become by markdown typed at its start. */
export type BlockOp = BlockKind | "divider";

/** What typing these at the start of a line, then a space, turns the line into. */
const SHORTCUTS: Record<string, BlockOp> = {
  "#": "h1", "##": "h2", "###": "h3", "-": "ul", "*": "ul", "+": "ul", "1.": "ol", "1)": "ol", ">": "quote", "[]": "todo", "[ ]": "todo", "[x]": "todo", "```": "code", "---": "divider", "!": "callout", ">>": "toggle",
};

/** The block a line's start makes, or undefined for ordinary text. */
export const shortcutOf = (prefix: string): BlockOp | undefined => SHORTCUTS[prefix];

/** Words wrapped in a mark just closed, at the end of the text before the caret: the mark's tag and the words. */
export function inlineMark(before: string): { tag: "strong" | "em" | "code" | "s"; words: string; length: number } | undefined {
  const bold = /\*\*([^*\n]+)\*\*$/.exec(before);
  if (bold) return { tag: "strong", words: bold[1]!, length: bold[0].length };
  const strike = /~~([^~\n]+)~~$/.exec(before);
  if (strike) return { tag: "s", words: strike[1]!, length: strike[0].length };
  const code = /`([^`\n]+)`$/.exec(before);
  if (code) return { tag: "code", words: code[1]!, length: code[0].length };
  const em = /(?:^|[^*\w])\*([^*\s][^*\n]*)\*$/.exec(before);
  if (em) return { tag: "em", words: em[1]!, length: em[1]!.length + 2 };
  return undefined;
}

export type SlashId = BlockKind | "divider" | "table" | "image" | "mention";

export interface SlashItem {
  id: SlashId;
  label: string;
  note: string;
  hint: string;
  icon: IconName;
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: "p", label: "Text", note: "Plain words", hint: "", icon: "text" },
  { id: "h1", label: "Heading 1", note: "A title", hint: "#", icon: "h1" },
  { id: "h2", label: "Heading 2", note: "A section", hint: "##", icon: "h2" },
  { id: "h3", label: "Heading 3", note: "A subsection", hint: "###", icon: "h3" },
  { id: "ul", label: "Bulleted list", note: "Points in any order", hint: "-", icon: "ul" },
  { id: "ol", label: "Numbered list", note: "Steps in order", hint: "1.", icon: "ol" },
  { id: "todo", label: "To-do list", note: "Boxes to tick", hint: "[]", icon: "todo" },
  { id: "toggle", label: "Toggle", note: "A line that opens to more", hint: ">>", icon: "toggle" },
  { id: "quote", label: "Quote", note: "Words set apart", hint: ">", icon: "quote" },
  { id: "callout", label: "Callout", note: "A note set apart", hint: "!", icon: "callout" },
  { id: "code", label: "Code", note: "A block of code", hint: "```", icon: "code" },
  { id: "divider", label: "Divider", note: "A rule between parts", hint: "---", icon: "divider" },
  { id: "table", label: "Table", note: "Rows and columns", hint: "", icon: "table" },
  { id: "image", label: "Image", note: "A picture from a file", hint: "", icon: "image" },
  { id: "mention", label: "Mention an artifact", note: "A link to another doc, deck or sheet", hint: "@", icon: "mention" },
];

/** The blocks whose name has every word typed after the slash. */
export const slashMatches = (query: string): SlashItem[] => {
  // "to-do", "todo" and "to do" all find the to-do list.
  const flat = (s: string): string => s.toLowerCase().replace(/-/g, "");
  const words = flat(query).split(/\s+/).filter(Boolean);
  return SLASH_ITEMS.filter((item) => {
    const parts = item.label.toLowerCase().split(/[\s-]+/);
    const label = flat(item.label);
    return words.every((w) => parts.some((part) => part.startsWith(w)) || label.split(" ").some((part) => part.startsWith(w)));
  });
};

export { IMAGE_MAX } from "./docpaste.js";

/** How long after the last keystroke the doc saves, and the least time between two saves (PageStore takes one edit every 2 s). */
export const AUTOSAVE_MS = 1200;
export const AUTOSAVE_GAP_MS = 2100;

/** The languages a code block offers, as the class names Markdown and highlighters read (language-*). */
export const CODE_LANGUAGES: readonly [string, string][] = [
  ["", "Plain text"], ["bash", "Bash"], ["c", "C"], ["cpp", "C++"], ["css", "CSS"], ["go", "Go"], ["html", "HTML"], ["java", "Java"],
  ["javascript", "JavaScript"], ["json", "JSON"], ["markdown", "Markdown"], ["python", "Python"], ["rust", "Rust"], ["sql", "SQL"],
  ["swift", "Swift"], ["typescript", "TypeScript"], ["yaml", "YAML"],
];

/** The colours words and highlights take: KOS's tokens, kept as classes (tc-*, hl-*) the doc's stylesheet colours. */
export const COLOURS: readonly [string, string][] = [["", "Default"], ["muted", "Grey"], ["accent", "Accent"], ["ok", "Green"], ["warn", "Amber"], ["danger", "Red"]];
const CALLOUTS: readonly [string, string][] = [["", "Accent"], ["note", "Grey"], ["ok", "Green"], ["warn", "Amber"], ["danger", "Red"]];

/** What an empty block says, by kind, so a new line says what to do with it. */
const PLACEHOLDER: Record<string, string> = { P: "Type / for blocks, @ to mention", H1: "Title", H2: "Heading", H3: "Heading", LI: "List", SUMMARY: "Toggle", CODE: "Code", BLOCKQUOTE: "Quote", TODO: "To-do" };
const PH = "data-kos-ph";

/** The bar's buttons that draw an icon rather than a letter. */
const BAR_ICONS = new Set<string>(["turn", "code", "link", "colour"]);

const run = (command: string, value?: string): boolean => document.execCommand(command, false, value);

export interface EditorOptions {
  /** Keep the article as it is now; resolves once saved. */
  save: () => Promise<unknown>;
  /** What the editor says to the owner: saving, saved, why not. */
  say: (text: string, bad?: boolean) => void;
  /** Whether an edit is waiting to be saved, each time that changes. */
  onPending?: (pending: boolean) => void;
}

export interface Editor {
  /** Save now if anything is waiting, then stop editing; false, and still editing, when the save was refused. */
  stop(): Promise<boolean>;
  /** Stop editing and save nothing more: what was not yet saved is the caller's to put back. */
  discard(): void;
  undo(): void;
  redo(): void;
}

/** The headings and the blocks with an id of their own, for a link to go to. */
function targets(article: HTMLElement): { id: string; text: string; el: HTMLElement }[] {
  const taken = new Set<string>();
  return [...article.querySelectorAll<HTMLElement>("h1, h2, h3, [id]")].flatMap((h) => {
    const text = h.textContent?.trim().slice(0, 80) ?? "";
    if (!text || h.closest("[data-kos-gen]:not([data-kos-gen='wrap'])") || taken.has(h.id)) return [];
    if (!h.id) {
      let id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "section";
      for (let n = 2; taken.has(id) || document.getElementById(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
      h.id = id;
      h.setAttribute("data-kos-gen-id", "");
    }
    taken.add(h.id);
    return [{ id: h.id, text, el: h }];
  });
}

/** An id for a block a link points at, kept (it is the doc's own once linked to). */
function idFor(block: HTMLElement): string {
  if (block.id) {
    block.removeAttribute("data-kos-gen-id");
    return block.id;
  }
  const words = (block.textContent ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "block";
  let id = words;
  for (let n = 2; document.getElementById(id); n++) id = `${words}-${n}`;
  block.id = id;
  return id;
}

const caretOf = (sel: Selection | null): Caret | undefined => (sel && sel.rangeCount ? { node: sel.getRangeAt(0).startContainer, offset: sel.getRangeAt(0).startOffset } : undefined);

/**
 * The selection's ends as nodes and offsets, to put back after its block
 * moves: a Range would collapse to the old parent as the block is taken out.
 */
function holdCaret(): () => void {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return () => undefined;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel;
  return () => {
    if (!anchorNode?.isConnected || !focusNode?.isConnected) return;
    sel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  };
}

/** Put the caret at a place, or at a node's start (or end). */
function place(caret: Caret | Node, end = false): void {
  const sel = getSelection();
  if (!sel) return;
  const r = document.createRange();
  if (caret instanceof Node) {
    r.selectNodeContents(caret);
    // Before a closing <br>, which only holds an empty line open.
    const last = caret.lastChild;
    if (end && last instanceof Element && last.tagName === "BR") r.setEndBefore(last);
    r.collapse(!end);
  } else r.setStart(caret.node, caret.offset);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * Wrap the words of a range in a mark (s, mark, code, a coloured span), or
 * take that mark off where all of it has it already. With `clearing`, the
 * marks it names come off first (another colour), and `tag` "" puts none back.
 */
export function toggleMark(range: Range, tag: string, className = "", clearing?: (el: Element) => boolean): void {
  const root = range.commonAncestorContainer;
  const scope = root instanceof Element ? root : root.parentElement!;
  const article = scope.closest("[data-doc]") ?? scope;
  const texts: Text[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n) && (n as Text).data.length) texts.push(n as Text);
  if (root instanceof Text && !texts.includes(root)) texts.push(root);
  const matches = (e: Element): boolean => (clearing ? clearing(e) : e.tagName.toLowerCase() === tag && (e.getAttribute("class") ?? "") === className);
  const markOf = (t: Node): Element | null => {
    for (let e = t.parentElement; e && e !== article; e = e.parentElement) if (matches(e)) return e;
    return null;
  };
  const marked = texts.filter((t) => !(t === range.startContainer && range.startOffset === t.length) && !(t === range.endContainer && range.endOffset === 0));
  const { startContainer, startOffset, endContainer, endOffset } = range;
  if (clearing || (marked.length > 0 && marked.every(markOf))) {
    for (const t of marked) {
      const m = markOf(t);
      m?.replaceWith(...m.childNodes);
    }
    if (!clearing || !tag) return;
  }
  let first: Node | undefined;
  let last: Node | undefined;
  for (let t of marked) {
    if (t === endContainer && endOffset < t.length) t.splitText(endOffset);
    if (t === startContainer && startOffset > 0) t = t.splitText(startOffset);
    const wrap = document.createElement(tag);
    if (className) wrap.className = className;
    t.replaceWith(wrap);
    wrap.append(t);
    first ??= wrap;
    last = wrap;
  }
  if (first && last) {
    const sel = getSelection();
    const r = document.createRange();
    r.setStartBefore(first);
    r.setEndAfter(last);
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
}

export function startEditor(article: HTMLElement, { save, say, onPending }: EditorOptions): Editor {
  run("defaultParagraphSeparator", "p");
  run("styleWithCSS", "false");
  const history = new History(article);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedAt = -Infinity;
  let pending = false;
  let stopped = false;
  const setPending = (on: boolean): void => {
    if (on !== pending) onPending?.(on);
    pending = on;
  };

  /*
   * Saves run one after another, never two at once (the second would be made
   * on the version before the first), and each waits out the server's gap
   * since the last, so Done right after an autosave is never "saved a moment
   * ago".
   */
  let chain: Promise<boolean> = Promise.resolve(true);
  const flush = (): Promise<boolean> =>
    (chain = chain.then(async () => {
      if (!pending || stopped) return true;
      const gap = savedAt + AUTOSAVE_GAP_MS - Date.now();
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      if (!pending || stopped) return true;
      setPending(false);
      say("Saving…");
      const ok = await save().then(
        () => {
          say("Saved");
          return true;
        },
        (e: unknown) => {
          // Kept as waiting, so the next keystroke or Done tries again; a newer version elsewhere is the dashboard's to explain (it offers Reload).
          setPending(true);
          say(`Not saved: ${reason(e)}`, true);
          return false;
        },
      );
      savedAt = Date.now();
      return ok;
    }));

  const lockChips = (): void => article.querySelectorAll(".mention").forEach((m) => m.setAttribute("contenteditable", "false"));
  ensureTodoBoxes(article);
  lockChips();

  /** Something changed: tidy what the browser left, redraw the editor's marks, and save a moment later. */
  const changed = (): void => {
    normalise(article);
    ensureTodoBoxes(article);
    lockChips();
    setPending(true);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    requestAnimationFrame(() => {
      drawPicked();
      placeTools();
      placeholder();
      if (hovered?.isConnected) showHandle(hovered);
      else showHandle(undefined);
    });
  };
  /** A block operation: kept for undo first, then made, then saved. */
  const edit = (fn: () => void): void => {
    history.record();
    fn();
    changed();
  };

  /* —— block selection: blocks picked whole, marked over the page —— */
  let picked: HTMLElement[] = [];
  let pickFrom: HTMLElement | undefined;
  const marks = el("div", { class: "doc-picks", "aria-hidden": "true" });
  const live = el("div", { class: "doc-live", role: "status", "aria-live": "polite" });
  document.body.append(marks, live);
  const tell = (words: string): void => {
    live.textContent = words;
  };
  const topmost = (blocks: HTMLElement[]): HTMLElement[] => blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b)));
  const span = (a: HTMLElement, b: HTMLElement): HTMLElement[] => {
    const all = allBlocks(article);
    const [i, j] = [all.indexOf(a), all.indexOf(b)].sort((x, y) => x - y) as [number, number];
    return topmost(all.slice(i, j + 1));
  };
  function drawPicked(): void {
    marks.replaceChildren(
      ...picked.filter((b) => b.isConnected).map((b) => {
        const r = b.getBoundingClientRect();
        return el("div", { class: "doc-pick", style: `left:${r.left + scrollX - 6}px;top:${r.top + scrollY - 2}px;width:${r.width + 12}px;height:${r.height + 4}px` });
      }),
    );
  }
  function pick(blocks: HTMLElement[], from = blocks[0]): void {
    picked = topmost(blocks.filter((b) => b.isConnected));
    pickFrom = from;
    if (picked.length) {
      getSelection()?.removeAllRanges();
      article.focus({ preventScroll: true });
      tell(`${picked.length} block${picked.length > 1 ? "s" : ""} selected`);
    }
    hideBar();
    placeholder();
    drawPicked();
  }
  const unpick = (): void => {
    if (!picked.length) return;
    picked = [];
    pickFrom = undefined;
    drawPicked();
  };
  /** The blocks an action applies to: the ones picked, or the ones a selection touches, or the caret's. */
  const acting = (): HTMLElement[] => {
    if (picked.length) return picked;
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    const a = blockOf(article, r.startContainer);
    const b = blockOf(article, r.endContainer);
    if (!a) return [];
    return b && b !== a ? span(a, b) : [a];
  };

  /* —— the "/" menu ——————————————————————————————————————————————— */
  const slashMenu = new Menu();
  let slash: { node: Text; offset: number } | undefined;
  const slashItems = (q: string): MenuItem[] => slashMatches(q).map((s) => ({ id: s.id, label: s.label, note: s.note, hint: s.hint, icon: s.icon }));
  const query = (): string | undefined => {
    const sel = getSelection();
    if (!slash || !sel || sel.rangeCount === 0 || !slash.node.isConnected) return undefined;
    const caret = sel.getRangeAt(0);
    if (caret.startContainer !== slash.node || caret.startOffset <= slash.offset) return undefined;
    return slash.node.data.slice(slash.offset + 1, caret.startOffset);
  };
  const caretRect = (): DOMRect => {
    const sel = getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : undefined;
    if (r && (r.width || r.height)) return r;
    const block = blockOf(article, sel?.anchorNode ?? null);
    const box = (block ? holderOf(block) : article).getBoundingClientRect();
    return new DOMRect(box.left, box.top, 0, Math.min(box.height, 28));
  };
  function openSlash(node: Text, offset: number): void {
    slash = { node, offset };
    slashMenu.show(slashItems(""), { at: caretRect(), label: "Insert a block", listbox: true, empty: "No block by that name", className: "doc-slash", onPick: (item) => chooseSlash(item.id as SlashId), onClose: () => void setTimeout(() => !slashMenu.open && (slash = undefined)) });
  }
  function chooseSlash(id: SlashId): void {
    const typed = query();
    const at = slash;
    slash = undefined;
    slashMenu.close();
    history.record();
    // The "/" and what was typed after it go.
    if (at && typed !== undefined) {
      at.node.deleteData(at.offset, typed.length + 1);
      place({ node: at.node, offset: at.offset });
    }
    const block = blockOf(article, getSelection()?.anchorNode ?? null);
    insertBlock(id, block);
    changed();
  }

  /** Put a block of a kind at the caret's block: that block becomes it when empty, or it goes after. */
  function insertBlock(id: SlashId, block: HTMLElement | undefined): void {
    if (id === "image") return pickImage();
    if (id === "mention") return askMention();
    const empty = !!block && isEmpty(block);
    if (id === "divider" || id === "table") {
      const made = id === "divider" ? document.createElement("hr") : newTable(document);
      put(made, block, empty && block?.tagName !== "LI");
      const next = made.nextElementSibling;
      if (!next || next.tagName === "HR" || id === "divider") {
        if (!next || !isEmpty(next)) {
          const p = document.createElement("p");
          p.append(document.createElement("br"));
          made.after(p);
        }
      }
      place(id === "table" ? made.querySelector("th, td")! : (made.nextElementSibling as HTMLElement), id === "table");
      return;
    }
    if (block && empty) {
      place(turnInto(article, block, id));
      return;
    }
    const p = document.createElement("p");
    p.append(document.createElement("br"));
    put(p, block, false);
    place(id === "p" ? p : turnInto(article, p, id));
  }
  /** Put a new block in place of an empty one, or after a block (splitting its list if it is a list item), or at the end. */
  function put(made: HTMLElement, block: HTMLElement | undefined, replace: boolean): void {
    if (!block) return void article.append(made);
    if (replace && block.tagName !== "LI") return void block.replaceWith(made);
    article.append(made);
    moveTo(article, made, block, "after");
    if (replace) removeBlocks(article, [block]);
  }

  /* —— images, read from a file or a paste and kept in the doc as data —— */
  const picker = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", hidden: true });
  document.body.append(picker);
  let imageAt: Range | undefined;
  function pickImage(): void {
    const sel = getSelection();
    imageAt = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : undefined;
    picker.click();
  }
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) addImage(file, imageAt);
  });
  function addImage(file: File, at: Range | undefined): void {
    if (file.size > IMAGE_MAX) return say(`That image is ${Math.round(file.size / 1000)} KB; a doc takes one up to ${Math.round(IMAGE_MAX / 1000)} KB.`, true);
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? "");
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(data)) return say("That file is not an image a doc can hold.", true);
      if (article.innerHTML.length + data.length > DOC_EDIT_MAX) return say("That image would make the doc longer than an edit can save; use a smaller one.", true);
      article.focus({ preventScroll: true });
      if (at) {
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(at);
      }
      const name = file.name.replace(/\.[^.]+$/, "") || "Image";
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = data;
      img.alt = name;
      figure.append(img, Object.assign(document.createElement("figcaption"), { textContent: name }));
      edit(() => {
        const block = blockOf(article, getSelection()?.anchorNode ?? null);
        put(figure, block, !!block && isEmpty(block) && block.tagName !== "LI");
        place(figure.querySelector("figcaption")!, true);
      });
    };
    reader.readAsDataURL(file);
  }

  /* —— @ mentions: the dashboard's picker (kos.mention), which answers with the one artifact chosen —— */
  let asking = false;
  function askMention(): void {
    const bridge = kos();
    if (!bridge?.mention || asking) return;
    const sel = getSelection();
    const at = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : undefined;
    const r = caretRect();
    asking = true;
    bridge.mention({ x: Math.round(r.left), y: Math.round(r.bottom) }).then(
      (picked) => {
        asking = false;
        if (!stopped) putMention(picked, at);
      },
      (e: unknown) => {
        asking = false;
        if (!stopped) say(`No mention: ${reason(e)}`, true);
      },
    );
  }
  function putMention(picked: { id?: unknown; title?: unknown } | null, at: Range | undefined): void {
    article.focus({ preventScroll: true });
    if (at && at.startContainer.isConnected) {
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(at);
    }
    if (!picked || typeof picked.id !== "string" || typeof picked.title !== "string" || !ARTIFACT_ID_RE.test(picked.id)) return;
    const id = picked.id;
    const title = picked.title.slice(0, 200);
    edit(() => {
      const sel = getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      // The "@" typed to ask goes; the chip and a space after it take its place.
      const node = range.startContainer;
      if (node instanceof Text && range.startOffset > 0 && node.data[range.startOffset - 1] === "@") {
        const back = range.startOffset - 1;
        node.deleteData(back, 1);
        range.setStart(node, back);
        range.collapse(true);
      }
      const chip = document.createElement("span");
      chip.className = "mention";
      chip.setAttribute("data-artifact", id);
      chip.textContent = title;
      const space = document.createTextNode("\u00a0");
      range.insertNode(space);
      range.insertNode(chip);
      place({ node: space, offset: 1 });
    });
  }

  /* —— the bar over a selection ——————————————————————————————————— */
  const bar = el("div", { class: "doc-format", role: "toolbar", "aria-label": "Format", hidden: true });
  const barMenu = new Menu();
  let saved: Range | undefined;
  const keepSel = (): Range | undefined => {
    const sel = getSelection();
    return sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : undefined;
  };
  const restore = (r: Range | undefined): void => {
    if (!r) return;
    article.focus({ preventScroll: true });
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(r);
  };
  const mark = (tag: string, cls = ""): void => {
    const r = keepSel();
    if (r) edit(() => toggleMark(r, tag, cls));
  };
  const command = (name: string): void => edit(() => void run(name));
  function linkMenu(at: DOMRect, r: Range | undefined): void {
    const list = targets(article);
    barMenu.show(
      list.map((t) => ({ id: t.id, label: t.text, icon: "link" as const })),
      {
        at,
        label: "Link to a part of this doc",
        empty: "Add a heading to link to",
        onPick: (item) => {
          restore(r);
          list.find((t) => t.id === item.id)?.el.removeAttribute("data-kos-gen-id");
          edit(() => void run("createLink", `#${item.id}`));
        },
        onClose: () => restore(r),
      },
    );
  }
  function colourMenu(at: DOMRect, r: Range | undefined): void {
    const isColour = (e: Element): boolean => e.tagName === "SPAN" && /(^|\s)tc-/.test(e.className);
    const isHighlight = (e: Element): boolean => e.tagName === "MARK";
    barMenu.show(
      [
        ...COLOURS.map(([c, label], i) => ({ id: `tc:${c}`, label, swatch: c ? `var(--${c})` : "var(--text)", group: i === 0 ? "Text" : undefined })),
        { id: "hl:", label: "No highlight", swatch: "transparent", group: "Highlight" },
        ...COLOURS.slice(1).map(([c, label]) => ({ id: `hl:${c}`, label, swatch: `color-mix(in srgb, var(--${c}) 30%, transparent)` })),
      ],
      {
        at,
        label: "Colour",
        className: "doc-colours",
        onPick: (item) => {
          restore(r);
          const range = keepSel();
          if (!range) return;
          const [kind, c] = item.id.split(":") as [string, string];
          edit(() => {
            if (kind === "tc") toggleMark(range, c ? "span" : "", c ? `tc-${c}` : "", isColour);
            else toggleMark(range, c ? "mark" : "", c ? `hl-${c}` : "", isHighlight);
          });
        },
        onClose: () => restore(r),
      },
    );
  }
  function turnMenu(at: DOMRect, blocks: HTMLElement[], back?: () => void): void {
    const current = blocks.length === 1 ? kindOf(blocks[0]!) : undefined;
    barMenu.show(
      TURN_INTO.map((t) => ({ id: t.kind, label: t.label, icon: (t.kind === "p" ? "text" : t.kind) as IconName, checked: t.kind === current })),
      { at, label: "Turn into", onPick: (item) => turnAll(blocks, item.id as BlockKind), onClose: back },
    );
  }
  function turnAll(blocks: HTMLElement[], kind: BlockKind): void {
    edit(() => {
      let last: HTMLElement | undefined;
      for (const b of blocks.filter((x) => x.isConnected)) last = turnInto(article, b, kind);
      unpick();
      if (last) place(last, true);
    });
  }
  const formats: [string, string, string, (b: HTMLButtonElement) => void][] = [
    ["turn", "Turn into", "turn", (b) => turnMenu(b.getBoundingClientRect(), acting(), () => restore(saved))],
    ["bold", "Bold (Cmd+B)", "B", () => command("bold")],
    ["italic", "Italic (Cmd+I)", "I", () => command("italic")],
    ["underline", "Underline (Cmd+U)", "U", () => command("underline")],
    ["strike", "Strikethrough (Cmd+Shift+X)", "S", () => mark("s")],
    ["code", "Code (Cmd+E)", "code", () => mark("code")],
    ["link", "Link to a part of this doc (Cmd+K)", "link", (b) => linkMenu(b.getBoundingClientRect(), saved)],
    ["colour", "Colour and highlight", "colour", (b) => colourMenu(b.getBoundingClientRect(), saved)],
  ];
  for (const [id, title, face, act] of formats) {
    const b = el("button", { type: "button", "data-format": id, title, "aria-label": title }, BAR_ICONS.has(face) ? icon(face as IconName) : face);
    if (id === "turn") b.append(el("span", {}, "Turn into"));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      saved = keepSel();
      act(b);
    });
    bar.append(b);
  }
  document.body.append(bar);
  const hideBar = (): void => {
    bar.hidden = true;
  };
  const placeBar = (): void => {
    const sel = getSelection();
    const on = !picked.length && sel && sel.rangeCount > 0 && !sel.isCollapsed && article.contains(sel.getRangeAt(0).commonAncestorContainer) && sel.toString().trim();
    if (!on) {
      if (!barMenu.open) hideBar();
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    bar.hidden = false;
    const w = bar.offsetWidth;
    bar.style.left = `${Math.round(Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8) + scrollX)}px`;
    bar.style.top = `${Math.round(Math.max(8, r.top - bar.offsetHeight - 8) + scrollY)}px`;
  };

  /* —— the handle and "+" beside the block under the pointer —————————— */
  const grip = el("button", { type: "button", class: "doc-grip", "aria-label": "Drag to move this block, or press for its menu", "aria-haspopup": "menu", title: "Drag to move\nClick for the block's menu" }, icon("grip", 18));
  const add = el("button", { type: "button", class: "doc-add", "aria-label": "Add a block below", title: "Add a block below" }, icon("plus", 18));
  const handle = el("div", { class: "doc-handle", hidden: true }, add, grip);
  const drop = el("div", { class: "doc-drop", hidden: true, "aria-hidden": "true" });
  document.body.append(handle, drop);
  const blockMenu = new Menu();
  let hovered: HTMLElement | undefined;
  let dragging: { blocks: HTMLElement[]; target?: HTMLElement; where?: "before" | "after" } | undefined;
  let press: { x: number; y: number } | undefined;

  function showHandle(block: HTMLElement | undefined): void {
    if (dragging) return;
    hovered = block;
    if (!block) {
      if (!blockMenu.open) handle.hidden = true;
      return;
    }
    const r = block.getBoundingClientRect();
    const holder = block.tagName === "TABLE" || block.hasAttribute("data-kos-gen") ? block : holderOf(block);
    const style = getComputedStyle(holder);
    const line = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.5;
    const top = holder.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + (Math.min(line, 44) - 24) / 2;
    const inset = block.tagName === "LI" ? (block.parentElement?.classList.contains("checklist") ? 2 : 20) : 0;
    handle.hidden = false;
    // In a column with no margin to spare (a narrow window), the handle keeps to the frame's edge.
    handle.style.left = `${Math.round(Math.max(0, r.left - inset - handle.offsetWidth - 4) + scrollX)}px`;
    handle.style.top = `${Math.round(top + scrollY)}px`;
  }
  /** The innermost block at a height on the page, within the text's width and a little either side (or at any x, for a drag or a sweep down the margin). */
  const blockAtPoint = (x: number | undefined, y: number): HTMLElement | undefined => {
    let best: HTMLElement | undefined;
    let area = Infinity;
    for (const b of allBlocks(article)) {
      const r = b.getBoundingClientRect();
      if (!r.height || y < r.top - 6 || y > r.bottom + 6 || (x !== undefined && (x < r.left - 96 || x > r.right + 24))) continue;
      const a = r.height * r.width;
      if (a < area) {
        area = a;
        best = b;
      }
    }
    return best;
  };
  let raf = 0;
  const pointerMoved = (e: PointerEvent): void => {
    if (dragging || e.pointerType === "touch") return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (handle.contains(e.target as Node) || blockMenu.open) return;
      const b = blockAtPoint(e.clientX, e.clientY);
      if (b !== hovered || (b && handle.hidden)) showHandle(b);
    });
  };

  // "+": a new line below, with the "/" menu open on it.
  add.addEventListener("mousedown", (e) => e.preventDefault());
  add.addEventListener("click", () => {
    const block = hovered;
    article.focus({ preventScroll: true });
    unpick();
    edit(() => {
      const p = document.createElement("p");
      const text = document.createTextNode("/");
      p.append(text);
      put(p, block, false);
      place({ node: text, offset: 1 });
    });
    const text = getSelection()?.anchorNode;
    if (text instanceof Text) openSlash(text, 0);
  });

  // The handle: pressed, the block's menu; dragged, the block (or the picked blocks) moves.
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !hovered) return;
    e.preventDefault();
    press = { x: e.clientX, y: e.clientY };
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener("pointermove", (e) => {
    if (!press || !hovered) return;
    if (!dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return;
    if (!dragging) {
      const moving = picked.includes(hovered) ? picked : [hovered];
      pick(moving);
      dragging = { blocks: moving };
      document.documentElement.classList.add("doc-dragging");
    }
    const target = blockAtPoint(undefined, e.clientY);
    if (!target || dragging.blocks.some((b) => b === target || b.contains(target) || target.contains(b))) {
      drop.hidden = true;
      dragging.target = undefined;
      return;
    }
    const r = target.getBoundingClientRect();
    const where = e.clientY < r.top + r.height / 2 ? "before" : "after";
    dragging.target = target;
    dragging.where = where;
    drop.hidden = false;
    drop.style.left = `${Math.round(r.left + scrollX)}px`;
    drop.style.width = `${Math.round(r.width)}px`;
    drop.style.top = `${Math.round((where === "before" ? r.top : r.bottom) + scrollY - 2)}px`;
  });
  const endPress = (e: PointerEvent): void => {
    if (!press) return;
    press = undefined;
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    const drag = dragging;
    dragging = undefined;
    drop.hidden = true;
    document.documentElement.classList.remove("doc-dragging");
    if (!drag) return;
    // The click that ends a drag opens no menu.
    grip.dataset.dragged = "1";
    setTimeout(() => delete grip.dataset.dragged, 0);
    if (e.type === "pointerup" && drag.target && drag.where) {
      const { target, where } = drag;
      edit(() => {
        const order = where === "after" ? [...drag.blocks].reverse() : drag.blocks;
        for (const b of order) moveTo(article, b, target, where);
      });
      tell("Moved");
    }
    pick(drag.blocks);
  };
  grip.addEventListener("pointerup", endPress);
  grip.addEventListener("pointercancel", endPress);
  grip.addEventListener("click", () => {
    if (grip.dataset.dragged || !hovered) return;
    openBlockMenu(picked.includes(hovered) ? picked : [hovered], grip.getBoundingClientRect());
  });

  function openBlockMenu(blocks: HTMLElement[], at: DOMRect): void {
    pick(blocks);
    const one = blocks.length === 1 ? blocks[0]! : undefined;
    const kind = one ? kindOf(one) : undefined;
    const items: MenuItem[] = [
      { id: "turn", label: "Turn into", icon: "turn", sub: () => TURN_INTO.map((t) => ({ id: `turn:${t.kind}`, label: t.label, icon: (t.kind === "p" ? "text" : t.kind) as IconName, checked: t.kind === kind })) },
      ...(one?.matches("aside.callout")
        ? [{ id: "colour", label: "Colour", icon: "colour" as const, sub: () => CALLOUTS.map(([c, label]) => ({ id: `callout:${c}`, label, swatch: `var(--${c === "" ? "accent" : c === "note" ? "muted" : c})`, checked: c ? one.classList.contains(c) : !CALLOUTS.some(([x]) => x && one.classList.contains(x)) })) }]
        : []),
      ...(one?.tagName === "PRE" ? [{ id: "lang", label: "Language", icon: "code" as const, sub: () => languageItems(one) }] : []),
      { id: "duplicate", label: "Duplicate", icon: "duplicate", hint: "⌘D" },
      { id: "up", label: "Move up", icon: "up", hint: "⌘⇧↑" },
      { id: "down", label: "Move down", icon: "down", hint: "⌘⇧↓" },
      ...(one ? [{ id: "link", label: "Copy link to block", icon: "link" as const }] : []),
      { id: "delete", label: "Delete", icon: "trash", hint: "Del", danger: true },
    ];
    blockMenu.show(items, {
      at,
      label: blocks.length > 1 ? `${blocks.length} blocks` : "Block",
      onPick: (item) => blockAction(item.id, blocks),
      onClose: () => {
        if (picked.length) article.focus({ preventScroll: true });
      },
    });
  }
  const languageItems = (pre: HTMLElement): MenuItem[] => {
    const now = [...(pre.querySelector("code")?.classList ?? [])].find((c) => c.startsWith("language-"))?.slice(9) ?? "";
    return CODE_LANGUAGES.map(([id, label]) => ({ id: `lang:${id}`, label, checked: id === now }));
  };
  function blockAction(action: string, blocks: HTMLElement[]): void {
    const live = blocks.filter((b) => b.isConnected);
    if (!live.length) return;
    const [verb, arg = ""] = action.split(":") as [string, string?];
    if (verb === "turn") return turnAll(live, arg as BlockKind);
    if (verb === "callout")
      return edit(() => {
        for (const [c] of CALLOUTS) if (c) live[0]!.classList.remove(c);
        if (arg) live[0]!.classList.add(arg);
      });
    if (verb === "lang") return setLanguage(live[0]!, arg);
    if (verb === "duplicate") return duplicateAll(live);
    if (verb === "up" || verb === "down") return moveAll(live, verb === "up" ? -1 : 1);
    if (verb === "delete") return deleteAll(live);
    if (verb === "link") {
      const id = idFor(live[0]!);
      changed();
      copyText(`#${id}`);
      say("Link copied: select words and paste it to link them to this block");
    }
  }
  function setLanguage(pre: HTMLElement, lang: string): void {
    edit(() => {
      const code = pre.querySelector("code") ?? pre.appendChild(document.createElement("code"));
      for (const c of [...code.classList]) if (c.startsWith("language-")) code.classList.remove(c);
      if (lang) code.classList.add(`language-${lang}`);
      if (!code.className) code.removeAttribute("class");
    });
  }
  function duplicateAll(blocks: HTMLElement[]): void {
    edit(() => {
      // A run of blocks is copied as a run, after its last.
      const copies = blocks.map((b) => duplicate(b));
      let after = blocks.at(-1)!;
      if (copies.length > 1)
        for (const c of copies) {
          moveTo(article, c, after, "after");
          after = c;
        }
      ensureTodoBoxes(article);
      if (picked.length) pick(copies);
      else place(holderOf(copies[0]!), true);
    });
    tell("Duplicated");
  }
  function moveAll(blocks: HTMLElement[], dir: -1 | 1): void {
    const at = holdCaret();
    history.record();
    if (!moveBlocks(article, blocks, dir)) return;
    if (!picked.length) at();
    changed();
    blocks[0]?.scrollIntoView?.({ block: "nearest" });
    tell(dir < 0 ? "Moved up" : "Moved down");
  }
  function deleteAll(blocks: HTMLElement[]): void {
    edit(() => {
      const next = removeBlocks(article, blocks);
      unpick();
      place(holderOf(next), true);
    });
    tell("Deleted");
  }
  const copier = el("textarea", { class: "doc-copier", "aria-hidden": "true", tabindex: "-1" });
  document.body.append(copier);
  function copyText(text: string): void {
    copier.value = text;
    copier.select();
    const ok = document.execCommand("copy");
    article.focus({ preventScroll: true });
    if (!ok) void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  /* —— a code block's language, a table's rows and columns, beside the caret —— */
  const langButton = el("button", { type: "button", class: "doc-codelang", "aria-haspopup": "menu", "aria-label": "Language" });
  const codeTools = el("div", { class: "doc-codetools", hidden: true }, langButton);
  const tableTools = el("div", { class: "doc-tabletools", role: "toolbar", "aria-label": "Table", hidden: true });
  const toolMenu = new Menu();
  const TABLE_OPS: [Parameters<typeof tableEdit>[1], string, string][] = [
    ["row-before", "Add a row above", "+ Row above"], ["row-after", "Add a row below", "+ Row below"], ["col-before", "Add a column to the left", "+ Column left"],
    ["col-after", "Add a column to the right", "+ Column right"], ["row-remove", "Delete this row", "− Row"], ["col-remove", "Delete this column", "− Column"],
  ];
  for (const [op, label, words] of TABLE_OPS) {
    const b = el("button", { type: "button", title: label, "aria-label": label, class: op.endsWith("remove") ? "danger" : undefined }, words);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const node = getSelection()?.anchorNode;
      const td = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLTableCellElement>("td, th");
      if (!td || !article.contains(td)) return;
      history.record();
      const next = tableEdit(td, op);
      if (!next) return say("A table keeps at least one row and one column.");
      place(next, true);
      changed();
    });
    tableTools.append(b);
  }
  document.body.append(codeTools, tableTools);
  let lastPre: HTMLElement | undefined;
  langButton.addEventListener("mousedown", (e) => e.preventDefault());
  langButton.addEventListener("click", () => {
    const pre = lastPre;
    if (!pre?.isConnected) return;
    toolMenu.show(languageItems(pre), { at: langButton.getBoundingClientRect(), label: "Language", onPick: (i) => setLanguage(pre, i.id.slice(5)), onClose: () => article.focus({ preventScroll: true }) });
  });
  function placeTools(): void {
    const node = getSelection()?.anchorNode ?? null;
    const block = node && article.contains(node) ? blockOf(article, node) : undefined;
    const pre = block?.tagName === "PRE" ? block : undefined;
    if (pre || !toolMenu.open) {
      codeTools.hidden = !pre;
      if (pre) lastPre = pre;
    }
    if (pre) {
      const r = pre.getBoundingClientRect();
      const lang = [...(pre.querySelector("code")?.classList ?? [])].find((c) => c.startsWith("language-"))?.slice(9) ?? "";
      langButton.textContent = CODE_LANGUAGES.find(([id]) => id === lang)?.[1] ?? lang;
      codeTools.style.left = `${Math.round(r.right - codeTools.offsetWidth - 8 + scrollX)}px`;
      codeTools.style.top = `${Math.round(r.top + 6 + scrollY)}px`;
    }
    const cell = (node instanceof Element ? node : node?.parentElement)?.closest("td, th");
    const table = cell && article.contains(cell) ? cell.closest("table") : null;
    tableTools.hidden = !table;
    if (table) {
      const r = (table.parentElement?.classList.contains("doc-table") ? table.parentElement : table).getBoundingClientRect();
      tableTools.style.left = `${Math.round(r.left + scrollX)}px`;
      // Above the table, over the line before it, rather than over the rows the owner is typing into or the text after.
      const above = r.top - tableTools.offsetHeight - 6;
      tableTools.style.top = `${Math.round((above > 0 ? above : r.bottom + 6) + scrollY)}px`;
    }
  }

  /* —— the empty line's placeholder ——————————————————————————————— */
  let shown: Element | undefined;
  function placeholder(): void {
    const sel = getSelection();
    const anchor = sel?.anchorNode ?? null;
    const block = sel?.isCollapsed && !picked.length && anchor && article.contains(anchor) ? blockOf(article, anchor) : undefined;
    let holder: Element | undefined = block ? holderOf(block) : undefined;
    if (block?.matches("aside, details, blockquote")) {
      const inner = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest("p, summary");
      if (inner && block.contains(inner)) holder = inner;
    }
    const on = holder && isEmpty(holder) && !holder.matches("td, th, figcaption") ? holder : undefined;
    if (shown && shown !== on) shown.removeAttribute(PH);
    shown = on;
    if (on) on.setAttribute(PH, on.matches("ul.checklist > li") ? PLACEHOLDER.TODO! : (PLACEHOLDER[on.tagName] ?? PLACEHOLDER.P!));
  }

  /* —— keys ———————————————————————————————————————————————————————— */
  const keydown = (e: KeyboardEvent): void => {
    if (slashMenu.open && slashMenu.key(e)) return void e.preventDefault();
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Undo and redo are the editor's own, so they cover block operations as well as typing.
    if (mod && k === "z") {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && k === "y") {
      e.preventDefault();
      return redo();
    }
    if (picked.length) return pickedKey(e, mod, k);
    const sel = getSelection();
    const caret = caretOf(sel);
    const block = caret ? blockOf(article, caret.node) : undefined;
    if (mod && e.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) {
      e.preventDefault();
      const blocks = acting();
      if (blocks.length) moveAll(blocks, k === "ArrowUp" ? -1 : 1);
      return;
    }
    if (mod && !e.shiftKey && k === "d") {
      e.preventDefault();
      const blocks = acting();
      if (blocks.length) duplicateAll(blocks);
      return;
    }
    if (mod && !e.shiftKey && (k === "b" || k === "i" || k === "u")) {
      e.preventDefault();
      return command(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
    }
    if (mod && !e.shiftKey && k === "e") {
      e.preventDefault();
      return mark("code");
    }
    if (mod && e.shiftKey && k === "x") {
      e.preventDefault();
      return mark("s");
    }
    if (mod && !e.shiftKey && k === "k") {
      e.preventDefault();
      saved = keepSel();
      if (!saved) return say("Select the words to link first");
      return linkMenu(bar.hidden ? caretRect() : bar.getBoundingClientRect(), saved);
    }
    if (e.key === "Escape") {
      // Escape picks the caret's block (or the blocks a selection touches); once a block is picked, Escape is the doc's (Done).
      const blocks = acting();
      if (blocks.length) {
        e.preventDefault();
        pick(blocks);
      }
      return;
    }
    if (!caret || !block || e.isComposing) return;
    if (e.key === "Enter" && !mod) return enter(e, block, caret);
    if (e.key === "Backspace" && !mod && !e.altKey && sel!.isCollapsed && atStart(innerOf(block, caret), caret)) {
      history.record();
      const at = mergeBack(article, block, caret);
      if (at === undefined) return;
      e.preventDefault();
      if (at === "select") {
        const all = allBlocks(article);
        const prev = all.slice(0, all.indexOf(block)).reverse().find((b) => !b.contains(block));
        if (prev) pick([prev]);
      } else place(at);
      return changed();
    }
    if (e.key === "Tab" && !mod) return tab(e, block, caret);
  };
  /** The paragraph or summary inside a callout, toggle or quote the caret is in, or the block. */
  const innerOf = (block: HTMLElement, caret: Caret): HTMLElement => {
    if (!block.matches("aside, details, blockquote")) return block;
    const inner = (caret.node instanceof Element ? caret.node : caret.node.parentElement)?.closest<HTMLElement>("p, summary");
    return inner && block.contains(inner) ? inner : block;
  };
  function enter(e: KeyboardEvent, block: HTMLElement, caret: Caret): void {
    const sel = getSelection()!;
    const cell = (caret.node instanceof Element ? caret.node : caret.node.parentElement)?.closest("td, th");
    // Shift+Enter leaves a code block; any other Enter there, or in a table's cell, is a new line within it.
    if (block.tagName === "PRE" && e.shiftKey) {
      e.preventDefault();
      return edit(() => {
        const p = document.createElement("p");
        p.append(document.createElement("br"));
        block.after(p);
        place(p);
      });
    }
    if (block.tagName === "PRE" || cell || e.shiftKey) {
      e.preventDefault();
      history.typed("insert");
      if (block.tagName === "PRE") {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        // A newline at the very end needs a second to show as a line.
        const text = document.createTextNode(atEnd(block, caret) && !(block.textContent ?? "").endsWith("\n") ? "\n\n" : "\n");
        r.insertNode(text);
        place({ node: text, offset: 1 });
      } else run("insertLineBreak");
      return changed();
    }
    e.preventDefault();
    history.record();
    if (!sel.isCollapsed) sel.getRangeAt(0).deleteContents();
    const at = splitBlock(article, block, caretOf(sel)!);
    if (at) place(at);
    else run("insertParagraph");
    changed();
  }
  function tab(e: KeyboardEvent, block: HTMLElement, caret: Caret): void {
    const cell = (caret.node instanceof Element ? caret.node : caret.node.parentElement)?.closest<HTMLTableCellElement>("td, th");
    if (cell && article.contains(cell)) {
      e.preventDefault();
      const cells = [...(cell.closest("table")?.querySelectorAll<HTMLTableCellElement>("td, th") ?? [])];
      let next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)];
      if (!next && !e.shiftKey) {
        history.record();
        next = tableEdit(cells.at(-1)!, "row-after");
        changed();
      }
      if (next) place(next, true);
      return;
    }
    if (block.tagName === "PRE" && !e.shiftKey) {
      e.preventDefault();
      history.typed("insert");
      run("insertText", "  ");
      return;
    }
    if (block.tagName !== "LI") return;
    e.preventDefault();
    const at = holdCaret();
    history.record();
    if (e.shiftKey ? outdent(block) : indent(block)) {
      at();
      changed();
    }
  }
  /** Keys while blocks are picked whole. */
  function pickedKey(e: KeyboardEvent, mod: boolean, k: string): void {
    const blocks = picked;
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      return deleteAll(blocks);
    }
    if (mod && e.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) {
      e.preventDefault();
      return moveAll(blocks, k === "ArrowUp" ? -1 : 1);
    }
    if (mod && k === "d") {
      e.preventDefault();
      return duplicateAll(blocks);
    }
    if (mod && k === "a") {
      e.preventDefault();
      return pick(topmost(allBlocks(article)));
    }
    if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      const all = topmost(allBlocks(article));
      const edge = k === "ArrowUp" ? blocks[0]! : blocks.at(-1)!;
      const at = all.findIndex((b) => b === edge || b.contains(edge));
      const next = all[at + (k === "ArrowUp" ? -1 : 1)];
      if (!next) return;
      if (e.shiftKey && pickFrom) pick(span(pickFrom, next), pickFrom);
      else pick([next]);
      next.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (e.key === "Enter" || e.key === "/") {
      e.preventDefault();
      const first = blocks[0]!;
      if (e.key === "/" || mod) {
        const r = first.getBoundingClientRect();
        return openBlockMenu(blocks, new DOMRect(r.left, r.top, 0, 24));
      }
      unpick();
      return place(holderOf(first), true);
    }
    if (e.key === "Escape") return unpick();
    if (e.key === "Tab" || e.key === "Shift" || mod || e.altKey) return;
    // A letter typed over picked blocks starts writing at the first one's end.
    if (e.key.length === 1) {
      e.preventDefault();
      const first = blocks[0]!;
      unpick();
      place(holderOf(first), true);
    }
  }

  function undo(): void {
    slashMenu.close();
    if (history.undo()) {
      unpick();
      changed();
    }
  }
  function redo(): void {
    slashMenu.close();
    if (history.redo()) {
      unpick();
      changed();
    }
  }

  /* —— typing: history, "/" and "@", markdown —————————————————————— */
  const beforeinput = (e: InputEvent): void => {
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      return e.inputType === "historyUndo" ? undo() : redo();
    }
    if (picked.length) return void e.preventDefault();
    history.typed(e.inputType.startsWith("delete") ? "delete" : "insert");
  };
  const input = (e: Event): void => {
    const ev = e as InputEvent;
    changed();
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return;
    const caret = sel.getRangeAt(0);
    const node = caret.startContainer;
    if (ev.inputType === "insertText" && (ev.data === "/" || ev.data === "@") && node instanceof Text) {
      const before = node.data[caret.startOffset - 2];
      // Only at a word's start: "and/or" and an email address are text.
      if (before === undefined || /\s/.test(before)) {
        const inCode = blockOf(article, node)?.tagName === "PRE";
        if (ev.data === "@" && !inCode) return askMention();
        if (ev.data === "/" && !inCode) return openSlash(node, caret.startOffset - 1);
      }
    }
    if (slash) {
      const typed = query();
      if (typed === undefined || /\s{2}|^\s/.test(typed)) slashMenu.close();
      else slashMenu.update(slashItems(typed));
      return;
    }
    if (ev.inputType !== "insertText" || !(node instanceof Text)) return;
    const block = blockOf(article, node);
    if (!block || block.tagName === "PRE") return;
    const r = document.createRange();
    r.setStart(holderOf(block), 0);
    r.setEnd(node, caret.startOffset);
    const line = r.toString().replace(/[ ​]/g, (c) => (c === " " ? " " : ""));
    if (ev.data === " " && /^(P|H[1-6]|LI)$/.test(block.tagName)) {
      const op = shortcutOf(line.slice(0, -1));
      // In a list item only a to-do's "[]" means something: "- " is text there.
      if (op && (block.tagName !== "LI" || op === "todo")) {
        history.record();
        r.deleteContents();
        if (op === "divider") {
          block.before(document.createElement("hr"));
          if (isEmpty(block)) block.replaceChildren(document.createElement("br"));
          place(holderOf(block));
        } else {
          const holder = turnInto(article, block, op);
          if (op === "todo" && /^\[x\]/i.test(line)) holder.setAttribute("data-checked", "true");
          place(holder);
        }
        return changed();
      }
    }
    if (ev.data === "-" && line === "---" && block.tagName === "P" && atEnd(block, { node, offset: caret.startOffset })) {
      history.record();
      r.deleteContents();
      block.before(document.createElement("hr"));
      block.replaceChildren(document.createElement("br"));
      place(block);
      return changed();
    }
    if (ev.data === "`" && line === "```") {
      history.record();
      r.deleteContents();
      place(turnInto(article, block, "code"));
      return changed();
    }
    if (ev.data === "*" || ev.data === "`" || ev.data === "~") {
      const m = inlineMark(line);
      if (!m || caret.startOffset < m.length) return;
      history.record();
      const at = caret.startOffset - m.length;
      node.deleteData(at, m.length);
      const rest = node.splitText(at);
      const wrap = document.createElement(m.tag);
      wrap.textContent = m.words;
      rest.before(wrap);
      // What is typed next is plain again: the caret goes after the mark, outside it.
      const after = document.createTextNode("​");
      wrap.after(after);
      place({ node: after, offset: 1 });
      changed();
    }
  };

  /* —— the pointer: to-dos, toggles, picking blocks ————————————————— */
  const mousedown = (e: MouseEvent): void => {
    const target = e.target as Element;
    if (e.shiftKey) {
      // Shift and a press: the blocks from the caret's (or the picked ones) to this one.
      const to = blockOf(article, target);
      const from = pickFrom ?? blockOf(article, getSelection()?.anchorNode ?? null);
      if (to && from && to !== from) {
        e.preventDefault();
        pick(span(from, to), from);
        return;
      }
    }
    if (picked.length) unpick();
  };
  const click = (e: MouseEvent): void => {
    const target = e.target as Element;
    const box = target.closest?.(".todo-box");
    if (box && article.contains(box)) {
      e.preventDefault();
      edit(() => tell(toggleTodo(box.parentElement!) ? "Done" : "Not done"));
      return;
    }
    // A toggle opens and closes at its arrow; its words are for typing.
    const summary = target.closest?.("summary");
    if (summary && article.contains(summary)) {
      e.preventDefault();
      if (e.clientX - summary.getBoundingClientRect().left < 24) {
        const details = summary.parentElement as HTMLDetailsElement;
        details.open = !details.open;
      }
    }
  };
  const keyOnBox = (e: KeyboardEvent): void => {
    const box = (e.target as Element).closest?.(".todo-box");
    if (box && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      e.stopPropagation();
      (box as HTMLElement).click();
    }
  };
  /** A press in the margin beside the text starts picking blocks by dragging over them. */
  let sweep: HTMLElement | undefined;
  const marginDown = (e: PointerEvent): void => {
    const target = e.target as Element;
    // The article runs the frame's width; its margins either side of the text are the article itself.
    if (e.button !== 0 || (target !== article && article.contains(target)) || target.closest(".doc-handle, .doc-menu, .doc-format, .doc-tabletools, .doc-codetools, .doc-toc, .doc-notes, button, a, input")) return;
    const box = article.getBoundingClientRect();
    if (e.clientY < box.top || e.clientY > box.bottom) return;
    const at = blockAtPoint(undefined, e.clientY);
    const r = at?.getBoundingClientRect();
    if (!at || !r || (e.clientX >= r.left - 4 && e.clientX <= r.right + 4)) return;
    sweep = at;
    e.preventDefault();
    pick([sweep]);
  };
  const marginMove = (e: PointerEvent): void => {
    if (!sweep || !(e.buttons & 1)) return;
    const to = blockAtPoint(undefined, e.clientY);
    if (to) pick(span(sweep, to), sweep);
  };
  const marginUp = (): void => {
    sweep = undefined;
  };

  /* —— paste and drop: the doc's own blocks, never markup from elsewhere —— */
  const paste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const data = e.clipboardData;
    if (!data) return;
    const sel = getSelection();
    const file = [...(data.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) return addImage(file, sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : undefined);
    const text = data.getData("text/plain");
    const html = data.getData("text/html");
    // A link to a block, pasted over words, links them there.
    const href = text.trim();
    if (sel && !sel.isCollapsed && /^#[\w-]+$/.test(href) && document.getElementById(href.slice(1))) return edit(() => void run("createLink", href));
    const block = blockOf(article, sel?.anchorNode ?? null);
    const parsed = html && block?.tagName !== "PRE" ? parseClipboard(html) : undefined;
    if (!parsed) {
      history.record();
      run("insertText", text);
      return changed();
    }
    const frag = cleanPaste(parsed.body, document);
    // Pictures pasted as data count against what an edit can save, as a picked one does.
    const pictures = [...frag.querySelectorAll("img")].reduce((sum, img) => sum + (img.getAttribute("src")?.length ?? 0), 0);
    if (pictures && article.innerHTML.length + pictures > DOC_EDIT_MAX) {
      frag.querySelectorAll("img").forEach((img) => (img.closest("figure") ?? img).remove());
      say("The pictures in that paste would make the doc longer than an edit can save, so they were left out.", true);
    }
    edit(() => insertFragment(frag, block));
  };
  function insertFragment(frag: DocumentFragment, block: HTMLElement | undefined): void {
    const sel = getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    if (isInline(frag) || !block) {
      const last = frag.lastChild;
      range.insertNode(frag);
      if (last?.parentNode) place({ node: last.parentNode, offset: [...last.parentNode.childNodes].indexOf(last as ChildNode) + 1 });
      return;
    }
    // Blocks: an empty line is replaced; a line with words splits at the caret, and they go between its halves.
    const blocks = [...frag.childNodes].filter((n): n is HTMLElement => n instanceof HTMLElement);
    const caret = caretOf(sel)!;
    const empty = isEmpty(block);
    if (!empty && atStart(block, caret)) {
      for (const b of blocks) {
        article.append(b);
        moveTo(article, b, block, "before");
      }
      return place(holderOf(blocks.at(-1)!), true);
    }
    let tail: HTMLElement | undefined;
    if (!empty && !atEnd(block, caret)) {
      const half = splitBlock(article, block, caret);
      tail = half ? blockOf(article, half.node) : undefined;
    }
    let at: HTMLElement = block;
    for (const b of blocks) {
      article.append(b);
      moveTo(article, b, at, "after");
      at = b.matches("ul, ol") && b.isConnected ? ((b.lastElementChild as HTMLElement | null) ?? b) : b;
    }
    if (empty) removeBlocks(article, [block]);
    if (tail && isEmpty(tail)) removeBlocks(article, [tail]);
    place(holderOf(at), true);
  }
  // A drop is text, as a plain paste is: never markup from elsewhere, though a picture file becomes the doc's own.
  const dragover = (e: DragEvent): void => e.preventDefault();
  const dropped = (e: DragEvent): void => {
    e.preventDefault();
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const sel = getSelection();
    if (at && sel && article.contains(at.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(at);
    }
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) return addImage(file, at ?? undefined);
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    if (text) {
      history.record();
      run("insertText", text);
    }
  };
  const moved = (): void => {
    // A caret that lands inside what is not typed into (a note's number, a chip, a to-do's box) goes just after it.
    const sel = getSelection();
    const anchor = sel?.isCollapsed && sel.anchorNode && article.contains(sel.anchorNode) ? sel.anchorNode : null;
    const before = anchor instanceof Element && anchor !== article ? anchor.childNodes[sel!.anchorOffset - 1] : undefined;
    const fixed =
      before instanceof Element && before.getAttribute("contenteditable") === "false" && !(before.nextSibling instanceof Text)
        ? before
        : (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('[contenteditable="false"]');
    if (fixed && fixed !== article && article.contains(fixed)) {
      // A caret after it at the line's end needs a character to stand on: a zero-width one, which no save keeps (cleanDocHtml).
      let after = fixed.nextSibling;
      if (!(after instanceof Text) && !fixed.classList.contains("todo-box")) fixed.after((after = document.createTextNode("\u200b")));
      const r = document.createRange();
      if (after instanceof Text) r.setStart(after, after.data.startsWith("\u200b") ? 1 : 0);
      else r.setStartAfter(fixed);
      sel!.removeAllRanges();
      sel!.addRange(r);
    }
    // A selection of words made while blocks were picked ends the picking.
    if (picked.length && sel && !sel.isCollapsed && sel.anchorNode && article.contains(sel.anchorNode)) unpick();
    placeBar();
    placeTools();
    placeholder();
    history.pause();
  };
  const blurred = (): void =>
    void setTimeout(() => {
      if (document.activeElement !== article) slashMenu.close();
    }, 150);
  const resized = (): void => {
    drawPicked();
    placeTools();
    if (hovered?.isConnected) showHandle(hovered);
  };

  article.addEventListener("keydown", keydown);
  article.addEventListener("keydown", keyOnBox, true);
  article.addEventListener("beforeinput", beforeinput);
  article.addEventListener("input", input);
  article.addEventListener("mousedown", mousedown);
  article.addEventListener("click", click);
  article.addEventListener("paste", paste);
  article.addEventListener("dragover", dragover);
  article.addEventListener("drop", dropped);
  article.addEventListener("blur", blurred);
  document.addEventListener("selectionchange", moved);
  document.addEventListener("pointermove", pointerMoved);
  document.addEventListener("pointerdown", marginDown);
  document.addEventListener("pointermove", marginMove);
  document.addEventListener("pointerup", marginUp);
  addEventListener("resize", resized);

  const teardown = (): void => {
    stopped = true;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    article.removeEventListener("keydown", keydown);
    article.removeEventListener("keydown", keyOnBox, true);
    article.removeEventListener("beforeinput", beforeinput);
    article.removeEventListener("input", input);
    article.removeEventListener("mousedown", mousedown);
    article.removeEventListener("click", click);
    article.removeEventListener("paste", paste);
    article.removeEventListener("dragover", dragover);
    article.removeEventListener("drop", dropped);
    article.removeEventListener("blur", blurred);
    document.removeEventListener("selectionchange", moved);
    document.removeEventListener("pointermove", pointerMoved);
    document.removeEventListener("pointerdown", marginDown);
    document.removeEventListener("pointermove", marginMove);
    document.removeEventListener("pointerup", marginUp);
    removeEventListener("resize", resized);
    shown?.removeAttribute(PH);
    article.querySelectorAll(".mention").forEach((m) => m.removeAttribute("contenteditable"));
    for (const m of [slashMenu, barMenu, blockMenu, toolMenu]) m.remove();
    for (const n of [bar, picker, handle, drop, marks, live, copier, codeTools, tableTools]) n.remove();
  };

  return {
    async stop() {
      clearTimeout(timer);
      if (!(await flush())) return false;
      teardown();
      return true;
    },
    discard() {
      setPending(false);
      teardown();
    },
    undo,
    redo,
  };
}
