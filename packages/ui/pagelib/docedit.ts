/**
 * Editing a doc where it is drawn, the way a document editor does: a bar of
 * formats over a selection, a "/" menu of blocks, markdown typed at the
 * start of a line ("# ", "- ", "1. ", "> ", "[] ") or around words ("**",
 * "`"), undo and redo, and a save of its own a moment after the owner stops
 * typing.
 *
 * It runs inside the doc's frame, on the browser's own editing of the
 * article (contenteditable and its commands), not on a model of its own: so
 * whatever the agent wrote (a callout, a pull quote, a footnote, a class) is
 * kept as written rather than dropped by a schema that did not know it, and
 * undo is the browser's. Nothing leaves the frame but kos.save, which the
 * dashboard relays only at the owner's hand and the server checks as it
 * checks any write. The markup it makes is the doc's own: no forms, no
 * frames, no links off the page (a link goes to a heading of the doc), so
 * the frame's policy and its guard hold as they were.
 */

import { el, reason } from "./runtime.js";

/** A block a line can become. */
export type BlockOp = "h1" | "h2" | "h3" | "ul" | "ol" | "quote" | "check";

/** What typing these at the start of a line, then a space, turns the line into. */
const SHORTCUTS: Record<string, BlockOp> = { "#": "h1", "##": "h2", "###": "h3", "-": "ul", "*": "ul", "1.": "ol", ">": "quote", "[]": "check", "[ ]": "check" };

/** The block a line's start makes, or undefined for ordinary text. */
export const shortcutOf = (prefix: string): BlockOp | undefined => SHORTCUTS[prefix];

/** Words wrapped in a mark just closed, at the end of the text before the caret: the mark's tag and the words. */
export function inlineMark(before: string): { tag: "strong" | "code"; words: string; length: number } | undefined {
  const bold = /\*\*([^*\n]+)\*\*$/.exec(before);
  if (bold) return { tag: "strong", words: bold[1]!, length: bold[0].length };
  const code = /`([^`\n]+)`$/.exec(before);
  if (code) return { tag: "code", words: code[1]!, length: code[0].length };
  return undefined;
}

export interface SlashItem {
  id: "h1" | "h2" | "h3" | "ul" | "ol" | "check" | "quote" | "divider" | "table" | "callout" | "image";
  label: string;
  hint: string;
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: "h1", label: "Heading 1", hint: "#" },
  { id: "h2", label: "Heading 2", hint: "##" },
  { id: "h3", label: "Heading 3", hint: "###" },
  { id: "ul", label: "Bulleted list", hint: "-" },
  { id: "ol", label: "Numbered list", hint: "1." },
  { id: "check", label: "Checklist", hint: "[]" },
  { id: "quote", label: "Quote", hint: ">" },
  { id: "divider", label: "Divider", hint: "---" },
  { id: "table", label: "Table", hint: "" },
  { id: "callout", label: "Callout", hint: "" },
  { id: "image", label: "Image from a file", hint: "" },
];

/** The blocks whose name has every word typed after the slash. */
export const slashMatches = (query: string): SlashItem[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return SLASH_ITEMS.filter((item) => words.every((w) => item.label.toLowerCase().split(/\s+/).some((part) => part.startsWith(w))));
};

/** The biggest image the doc takes inline: it has no network, so the picture is part of its text. */
export const IMAGE_MAX = 300_000;

/** How long after the last keystroke the doc saves, and the least time between two saves (PageStore takes one edit every 2 s). */
export const AUTOSAVE_MS = 1200;
export const AUTOSAVE_GAP_MS = 2100;

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption,aside,div,td,th";

const run = (command: string, value?: string): boolean => document.execCommand(command, false, value);

/** Markup put in at the caret, on the undo stack, without the inline styles the browser copies onto it. */
const NEW = "data-kos-new";
function insert(html: string): void {
  run("insertHTML", html.replace(/^<([a-z0-9]+)/i, `<$1 ${NEW}`));
  for (const node of document.querySelectorAll(`[${NEW}]`)) {
    node.removeAttribute(NEW);
    node.removeAttribute("style");
    node.querySelectorAll("[style]").forEach((n) => n.removeAttribute("style"));
  }
}

export interface EditorOptions {
  /** Keep the article as it is now; resolves once saved. */
  save: () => Promise<unknown>;
  /** What the editor says to the owner: saving, saved, why not. */
  say: (text: string, bad?: boolean) => void;
}

export interface Editor {
  /** Save now if anything is waiting, then stop editing; false, and still editing, when the save was refused. */
  stop(): Promise<boolean>;
}

/** The block element holding the caret, inside the article. */
function blockAt(article: HTMLElement, node: Node | null): HTMLElement | undefined {
  const start = node instanceof Element ? node : node?.parentElement;
  const block = start?.closest<HTMLElement>(BLOCKS);
  return block && article.contains(block) && block !== article ? block : undefined;
}

/** The text of the caret's block up to the caret, and a range over it. */
function lineBefore(article: HTMLElement): { text: string; range: Range; block: HTMLElement | undefined } | undefined {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return undefined;
  const caret = sel.getRangeAt(0);
  if (!article.contains(caret.startContainer)) return undefined;
  const block = blockAt(article, caret.startContainer);
  const range = document.createRange();
  range.setStart(block ?? article, 0);
  range.setEnd(caret.startContainer, caret.startOffset);
  return { text: range.toString(), range, block };
}

/** Select the last `n` characters before the caret, within its text node. */
function selectBack(n: number): boolean {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const caret = sel.getRangeAt(0);
  if (caret.startContainer.nodeType !== Node.TEXT_NODE || caret.startOffset < n) return false;
  const range = document.createRange();
  range.setStart(caret.startContainer, caret.startOffset - n);
  range.setEnd(caret.startContainer, caret.startOffset);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/** The headings of the doc, given an id of their own if they have none, for a link to go to. */
function headings(article: HTMLElement): { id: string; text: string }[] {
  const taken = new Set<string>();
  return [...article.querySelectorAll<HTMLElement>("h1, h2, h3")].flatMap((h) => {
    const text = h.textContent?.trim() ?? "";
    if (!text) return [];
    if (!h.id) {
      let id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "section";
      for (let n = 2; taken.has(id) || document.getElementById(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
      h.id = id;
    }
    taken.add(h.id);
    return [{ id: h.id, text }];
  });
}

export function startEditor(article: HTMLElement, { save, say }: EditorOptions): Editor {
  // A new line is a paragraph, as the doc's own are, not a div.
  run("defaultParagraphSeparator", "p");
  run("styleWithCSS", "false");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedAt = -Infinity;
  let pending = false;
  let saving: Promise<boolean> | undefined;
  let stopped = false;

  const flush = async (): Promise<boolean> => {
    if (!pending || stopped) return true;
    pending = false;
    say("Saving…");
    saving = save().then(
      () => {
        say("Saved");
        return true;
      },
      (e: unknown) => {
        // Kept as waiting, so the next keystroke or Done tries again; a newer version elsewhere is the dashboard's to explain (it offers Reload).
        pending = true;
        say(`Not saved: ${reason(e)}`, true);
        return false;
      },
    );
    const ok = await saving;
    savedAt = Date.now();
    return ok;
  };
  const changed = (): void => {
    pending = true;
    clearTimeout(timer);
    const wait = Math.max(AUTOSAVE_MS, savedAt + AUTOSAVE_GAP_MS - Date.now());
    timer = setTimeout(() => void flush(), wait);
  };

  // —— the bar of formats over a selection ——
  const sections = el("div", { class: "doc-format-links", hidden: true });
  const bar = el("div", { class: "doc-format", role: "toolbar", "aria-label": "Format", hidden: true });
  const formats: [string, string, string, () => void][] = [
    ["bold", "B", "Bold (Cmd+B)", () => run("bold")],
    ["italic", "I", "Italic (Cmd+I)", () => run("italic")],
    ["code", "</>", "Code", () => {
      const text = getSelection()?.toString() ?? "";
      if (text) insert(`<code>${escapeHtml(text)}</code>`);
    }],
    ["link", "Link", "Link to a section of this doc", () => {
      const list = headings(article);
      sections.replaceChildren(
        ...(list.length
          ? list.map((h) => {
              const b = el("button", { type: "button" }, h.text);
              b.addEventListener("mousedown", (e) => e.preventDefault());
              b.addEventListener("click", () => {
                run("createLink", `#${h.id}`);
                sections.hidden = true;
                changed();
              });
              return b;
            })
          : [el("span", {}, "Add a heading to link to.")]),
      );
      sections.hidden = !sections.hidden;
    }],
    ["h1", "H1", "Heading 1", () => block("h1")],
    ["h2", "H2", "Heading 2", () => block("h2")],
    ["h3", "H3", "Heading 3", () => block("h3")],
    ["ul", "•", "Bulleted list", () => block("ul")],
    ["ol", "1.", "Numbered list", () => block("ol")],
    ["quote", "“", "Quote", () => block("quote")],
  ];
  for (const [id, text, title, act] of formats) {
    const b = el("button", { type: "button", "data-format": id, title, "aria-label": title }, text);
    // Pressing a format keeps the selection it formats.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      act();
      if (id !== "link") changed();
    });
    bar.append(b);
  }
  bar.append(sections);
  document.body.append(bar);

  const placeBar = (): void => {
    const sel = getSelection();
    const on = sel && sel.rangeCount > 0 && !sel.isCollapsed && article.contains(sel.getRangeAt(0).commonAncestorContainer);
    if (!on) {
      bar.hidden = true;
      sections.hidden = true;
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    bar.hidden = false;
    const w = bar.offsetWidth;
    bar.style.left = `${Math.round(Math.min(Math.max(8, r.left + r.width / 2 - w / 2 + scrollX), scrollX + innerWidth - w - 8))}px`;
    bar.style.top = `${Math.round(Math.max(8, r.top + scrollY - bar.offsetHeight - 8))}px`;
  };

  /** Turn the caret's line into a block, or back into a paragraph if it is one already. */
  function block(op: BlockOp): void {
    const current = blockAt(article, getSelection()?.anchorNode ?? null);
    const tag = op === "quote" ? "blockquote" : op;
    if (op === "ul") run("insertUnorderedList");
    else if (op === "ol") run("insertOrderedList");
    else if (op === "check") insert('<ul class="checklist"><li data-checked="false"><br></li></ul>');
    else run("formatBlock", current?.tagName.toLowerCase() === tag ? "p" : tag);
  }

  // —— the "/" menu of blocks ——
  const menu = el("div", { class: "doc-slash", role: "listbox", "aria-label": "Insert a block", hidden: true });
  document.body.append(menu);
  let slash: { node: Node; offset: number } | undefined;
  let choices: SlashItem[] = [];
  let pick = 0;
  const picker = el("input", { type: "file", accept: "image/*", hidden: true });
  document.body.append(picker);

  const closeMenu = (): void => {
    slash = undefined;
    menu.hidden = true;
  };
  const drawMenu = (): void => {
    menu.replaceChildren(
      ...(choices.length
        ? choices.map((item, i) => {
            const b = el("button", { type: "button", role: "option", "aria-selected": i === pick ? "true" : "false" }, el("span", {}, item.label), item.hint ? el("kbd", {}, item.hint) : null);
            b.addEventListener("mousedown", (e) => e.preventDefault());
            b.addEventListener("click", () => choose(item));
            return b;
          })
        : [el("p", { class: "doc-slash-none" }, "No block by that name")]),
    );
  };
  const query = (): string | undefined => {
    const sel = getSelection();
    if (!slash || !sel || sel.rangeCount === 0) return undefined;
    const caret = sel.getRangeAt(0);
    if (caret.startContainer !== slash.node || caret.startOffset <= slash.offset) return undefined;
    return (slash.node.textContent ?? "").slice(slash.offset + 1, caret.startOffset);
  };
  function choose(item: SlashItem): void {
    const typed = query();
    if (typed !== undefined && selectBack(typed.length + 1)) run("delete");
    closeMenu();
    if (item.id === "divider") run("insertHorizontalRule");
    else if (item.id === "table") insert("<table><thead><tr><th>Column</th><th>Column</th></tr></thead><tbody><tr><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td></tr></tbody></table><p><br></p>");
    else if (item.id === "callout") insert('<aside class="callout"><p>Note</p></aside><p><br></p>');
    else if (item.id === "image") picker.click();
    else block(item.id);
    changed();
  }
  const caretSaved = { range: undefined as Range | undefined };
  picker.addEventListener("click", () => {
    const sel = getSelection();
    caretSaved.range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : undefined;
  });
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    if (file.size > IMAGE_MAX) {
      say(`That image is ${Math.round(file.size / 1000)} KB; a doc takes one up to ${IMAGE_MAX / 1000} KB.`, true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? "");
      if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(data)) return say("That file is not an image a doc can hold.", true);
      article.focus();
      const sel = getSelection();
      if (caretSaved.range && sel) {
        sel.removeAllRanges();
        sel.addRange(caretSaved.range);
      }
      insert(`<figure><img src="${data}" alt="${escapeHtml(file.name.replace(/\.[^.]+$/, ""))}"><figcaption>${escapeHtml(file.name.replace(/\.[^.]+$/, ""))}</figcaption></figure><p><br></p>`);
      changed();
    };
    reader.readAsDataURL(file);
  });

  // —— keys, shortcuts and typing ——
  const keydown = (e: KeyboardEvent): void => {
    if (!menu.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        pick = (pick + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % Math.max(1, choices.length);
        drawMenu();
        return;
      }
      if (e.key === "Enter" && choices[pick]) {
        e.preventDefault();
        choose(choices[pick]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        return;
      }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      bar.querySelector<HTMLButtonElement>('[data-format="link"]')?.click();
    }
  };
  const input = (e: Event): void => {
    const ev = e as InputEvent;
    changed();
    const line = lineBefore(article);
    if (ev.inputType === "insertText" && ev.data === "/" && line && line.text.trim() === "/") {
      const sel = getSelection()!.getRangeAt(0);
      slash = { node: sel.startContainer, offset: sel.startOffset - 1 };
      choices = [...SLASH_ITEMS];
      pick = 0;
      drawMenu();
      const r = sel.getBoundingClientRect();
      menu.hidden = false;
      menu.style.left = `${Math.round(Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - menu.offsetWidth - 8)))}px`;
      menu.style.top = `${Math.round(r.bottom + scrollY + 6)}px`;
      return;
    }
    if (slash) {
      const typed = query();
      if (typed === undefined || /\s{2}/.test(typed)) closeMenu();
      else {
        choices = slashMatches(typed);
        pick = 0;
        drawMenu();
      }
      return;
    }
    if (ev.inputType !== "insertText" || !line) return;
    if (ev.data === " ") {
      const op = shortcutOf(line.text.replace(/ /g, " ").slice(0, -1));
      // Only at the start of a paragraph or a heading: in a list item "- " is text.
      if (op && (!line.block || /^(P|H[1-6]|DIV)$/.test(line.block.tagName)) && selectBack(line.text.length)) {
        run("delete");
        block(op);
      }
      return;
    }
    if (ev.data === "*" || ev.data === "`") {
      const mark = inlineMark(line.text);
      if (mark && selectBack(mark.length)) {
        insert(`<${mark.tag}>${escapeHtml(mark.words)}</${mark.tag}>`);
        // What is typed next is plain again.
        if (mark.tag === "strong" && document.queryCommandState("bold")) run("bold");
      }
    }
  };
  // A checklist's box is drawn before each item: a press there ticks it.
  const click = (e: MouseEvent): void => {
    const li = (e.target as Element | null)?.closest?.("ul.checklist > li");
    if (!(li instanceof HTMLElement) || !article.contains(li)) return;
    if (e.clientX - li.getBoundingClientRect().left > 26) return;
    e.preventDefault();
    li.setAttribute("data-checked", li.getAttribute("data-checked") === "true" ? "false" : "true");
    changed();
  };
  const paste = (e: ClipboardEvent): void => {
    e.preventDefault();
    run("insertText", e.clipboardData?.getData("text/plain") ?? "");
  };
  const moved = (): void => placeBar();
  const left = (): void => void setTimeout(closeMenu, 150);

  article.addEventListener("keydown", keydown);
  article.addEventListener("input", input);
  article.addEventListener("click", click);
  article.addEventListener("paste", paste);
  article.addEventListener("blur", left);
  document.addEventListener("selectionchange", moved);

  return {
    async stop() {
      clearTimeout(timer);
      await saving;
      if (!(await flush())) return false;
      stopped = true;
      article.removeEventListener("keydown", keydown);
      article.removeEventListener("input", input);
      article.removeEventListener("click", click);
      article.removeEventListener("paste", paste);
      article.removeEventListener("blur", left);
      document.removeEventListener("selectionchange", moved);
      bar.remove();
      menu.remove();
      picker.remove();
      return true;
    },
  };
}
