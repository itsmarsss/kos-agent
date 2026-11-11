/**
 * kos-doc: a designed document from plain markup. The agent writes one
 * `<article data-doc>`; this numbers its footnotes and figures, wraps its
 * tables so they scroll on their own, builds a table of contents for a long
 * one, and lets the owner edit it in place as in a document editor
 * (docedit.ts), each pause in typing kept as a version through kos.save. What it adds is marked data-kos-gen and taken
 * out again before a save, so an edit stores only what the agent wrote and
 * the owner changed.
 */

import { DOC_CSS } from "./doc.css.js";
import { DOC_EDIT_MAX } from "@kos/shared/artifacts";

import { startEditor, type Editor } from "./docedit.js";
import { addStyle, editable, el, kos, ready, reducedMotion } from "./runtime.js";

/** How many h2s make a document long enough for a table of contents. */
export const TOC_MIN = 4;

const GEN = "data-kos-gen";
const GEN_ID = "data-kos-gen-id";
const WRAP = "wrap";

/** A heading's text as an id: lower case, words joined by dashes, unique in the page. */
export function slugOf(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "section";
  let id = base;
  for (let n = 2; taken.has(id) || document.getElementById(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Take out of an article, in place, everything the runtime put in. */
export function stripGenerated(root: Element): void {
  for (const node of [...root.querySelectorAll(`[${GEN}]`)]) {
    if (node.getAttribute(GEN) === WRAP) node.replaceWith(...node.childNodes);
    else node.remove();
  }
  for (const node of [...root.querySelectorAll(`[${GEN_ID}]`)]) {
    node.removeAttribute("id");
    node.removeAttribute(GEN_ID);
  }
  root.querySelectorAll(".fn-shown").forEach((n) => n.classList.remove("fn-shown"));
}

/**
 * The article as it should be stored: its inner HTML with the runtime's
 * additions gone and the editing state off. Footnotes stay where the author
 * put them, as `<span class="fn">`.
 */
export function cleanDocHtml(article: Element): string {
  const copy = article.cloneNode(true) as Element;
  stripGenerated(copy);
  for (const node of [copy, ...copy.querySelectorAll("[contenteditable],[spellcheck]")]) {
    node.removeAttribute("contenteditable");
    node.removeAttribute("spellcheck");
  }
  return copy.innerHTML.trim();
}

function scrollTo(target: Element): void {
  target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  if (target instanceof HTMLElement) {
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  }
}

interface Enhanced {
  /** Undo everything, for an edit. */
  undo(): void;
}

/** Number footnotes, wrap tables, give headings ids, add the contents and the notes. */
export function enhance(article: HTMLElement): Enhanced {
  const frame = article.parentElement?.classList.contains("doc-frame") ? article.parentElement : el("div", { class: "doc-frame" });
  if (!frame.contains(article)) {
    article.replaceWith(frame);
    frame.append(article);
  }

  // Headings, with ids the contents can jump to.
  const taken = new Set<string>();
  const headings = [...article.querySelectorAll<HTMLElement>("h2, h3")];
  for (const h of headings) {
    if (h.id) continue;
    h.id = slugOf(h.textContent ?? "", taken);
    h.setAttribute(GEN_ID, "");
  }

  // Tables scroll inside their own wrapper.
  for (const table of article.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("doc-table")) continue;
    const wrap = el("div", { class: table.classList.contains("doc-wide") ? "doc-table doc-table-wide" : "doc-table" });
    wrap.setAttribute(GEN, WRAP);
    table.replaceWith(wrap);
    wrap.append(table);
  }

  // Footnotes: a number in the text, the note at the end.
  const notes = [...article.querySelectorAll<HTMLElement>(".fn")];
  let endnotes: HTMLElement | undefined;
  if (notes.length) {
    const list = el("ol");
    notes.forEach((fn, i) => {
      const n = String(i + 1);
      const ref = el("button", { type: "button", class: "fn-ref", id: `fnref-${n}`, "aria-label": `Note ${n}` }, n);
      const item = el("li", { id: `fn-${n}` }, ...[...fn.childNodes].map((c) => c.cloneNode(true)));
      const back = el("button", { type: "button", class: "fn-back", "aria-label": `Back to the text of note ${n}` }, "↩");
      item.append(back);
      ref.addEventListener("click", () => scrollTo(item));
      back.addEventListener("click", () => {
        ref.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
        ref.focus({ preventScroll: true });
      });
      fn.after(ref);
      list.append(item);
    });
    endnotes = el("section", { class: "doc-notes", "aria-label": "Notes" }, el("h2", {}, "Notes"), list);
    article.after(endnotes);
  }

  // The contents, for a long document.
  const sections = headings.filter((h) => h.tagName === "H2");
  let toc: HTMLElement | undefined;
  let watcher: IntersectionObserver | undefined;
  if (sections.length >= TOC_MIN) {
    const list = el("ol");
    const byId = new Map<string, HTMLButtonElement>();
    for (const h of headings) {
      const b = el("button", { type: "button" }, h.textContent?.trim() ?? "");
      b.addEventListener("click", () => scrollTo(h));
      byId.set(h.id, b);
      list.append(el("li", { class: h.tagName === "H3" ? "sub" : undefined }, b));
    }
    const fold = el("details", {}, el("summary", {}, "Contents"), list);
    // Open beside the text, folded above it. Followed, not read once: a frame can run its runtime before it has its width.
    if (typeof matchMedia === "function") {
      const wide = matchMedia("(min-width: 1100px)");
      fold.open = wide.matches;
      wide.addEventListener("change", (e) => {
        fold.open = e.matches;
      });
    }
    toc = el("nav", { class: "doc-toc", "aria-label": "Contents" }, fold);
    frame.classList.add("has-toc");
    frame.prepend(toc);
    if (typeof IntersectionObserver === "function") {
      const visible = new Set<Element>();
      watcher = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) visible.add(e.target);
            else visible.delete(e.target);
          }
          const current = headings.find((h) => visible.has(h)) ?? undefined;
          if (!current) return;
          for (const [id, b] of byId) b.setAttribute("aria-current", String(id === current.id));
        },
        { rootMargin: "0px 0px -70% 0px" },
      );
      headings.forEach((h) => watcher!.observe(h));
    }
  }

  return {
    undo() {
      watcher?.disconnect();
      toc?.remove();
      endnotes?.remove();
      frame.classList.remove("has-toc");
      stripGenerated(article);
    },
  };
}

/** What the doc tells the dashboard about its editing, which draws the controls in the viewer's head (ArtifactHead.tsx). */
export interface EditState {
  __kos: "edit";
  editing: boolean;
  /** An edit waiting to be saved. */
  pending: boolean;
  status: string;
  bad: boolean;
}

/** What the viewer's head asks of the doc. */
export type EditAction = "edit" | "done" | "discard" | "undo" | "redo";

/**
 * While editing, the doc stays laid out as it reads: its contents beside it,
 * its column where it was, its notes numbered. A note's text stays at the end
 * until its number is pressed, which opens it in the line to be edited.
 */
const EDIT_CSS = `[data-doc][contenteditable="true"] .fn:not(.fn-shown) { display: none; }
[data-doc][contenteditable="true"] .fn-ref { cursor: pointer; }`;

/**
 * Editing: the doc becomes editable where it is (docedit.ts holds the
 * formats, the "/" menu and the markdown), each pause in typing saved as a
 * new version through kos.save. Its controls (Edit, Done, Discard, Undo,
 * Redo and the save's state) are the dashboard's, kept in view above the
 * frame while the doc scrolls by: the doc says how its editing stands and
 * the dashboard says what the owner pressed. Cmd+S and Escape finish here
 * too.
 */
function editing(article: HTMLElement, start: () => Enhanced): void {
  const bridge = kos();
  if (article.hasAttribute("data-locked") || !editable() || !bridge?.save) return;
  const save = bridge.save.bind(bridge);
  let enhanced = start();
  let editor: Editor | undefined;
  /** The article as last saved (or as editing began), to put back on Discard; and its clean HTML, to skip a save that changes nothing. */
  let savedInner = "";
  let last = "";
  const state: EditState = { __kos: "edit", editing: false, pending: false, status: "", bad: false };
  const tell = (change: Partial<EditState>): void => {
    Object.assign(state, change);
    top?.postMessage({ ...state }, "*");
  };
  const say = (status: string, bad = false): void => tell({ status, bad });
  /** The doc as editing began, so leaving redraws its contents and notes only when something changed. */
  let began = "";
  /** Typed into since editing began: even a deleted note number, which the saved text never holds, needs the notes numbered again. */
  let typed = false;
  article.addEventListener("input", () => {
    if (editor) typed = true;
  });

  const begin = (): void => {
    if (editor) return;
    // What the runtime added stays, and is never typed into; the save takes it out again (cleanDocHtml).
    article.querySelectorAll(".fn-ref").forEach((ref) => ref.setAttribute("contenteditable", "false"));
    savedInner = article.innerHTML;
    last = began = cleanDocHtml(article);
    typed = false;
    article.setAttribute("contenteditable", "true");
    article.setAttribute("spellcheck", "true");
    document.documentElement.setAttribute("data-editing", "");
    article.focus();
    editor = startEditor(article, {
      say,
      onPending: (pending) => tell({ pending }),
      // An edit that changes nothing is no version; the server refuses one anyway. One too long would only be refused.
      save: async () => {
        const html = cleanDocHtml(article);
        if (html === last) return;
        if (html.length > DOC_EDIT_MAX) throw new Error(`the doc is ${html.length} characters; an edit saves at most ${DOC_EDIT_MAX}. Take something out, or Discard`);
        const inner = article.innerHTML;
        await save({ doc: html });
        last = html;
        savedInner = inner;
      },
    });
    tell({ editing: true, status: "", bad: false });
  };
  const leave = (redraw = typed || cleanDocHtml(article) !== began || article.querySelectorAll(".fn-ref").length !== article.querySelectorAll(".fn").length): void => {
    editor = undefined;
    article.removeAttribute("contenteditable");
    article.removeAttribute("spellcheck");
    document.documentElement.removeAttribute("data-editing");
    article.querySelectorAll(".fn-shown").forEach((n) => n.classList.remove("fn-shown"));
    // Numbered again and the contents rebuilt for what the owner wrote; untouched, it stays as it was.
    if (redraw) {
      enhanced.undo();
      enhanced = start();
    } else article.querySelectorAll(".fn-ref").forEach((ref) => ref.removeAttribute("contenteditable"));
    tell({ editing: false, pending: false });
  };
  const finish = async (): Promise<void> => {
    if (!editor) return;
    if (await editor.stop()) leave();
  };
  const discard = (): void => {
    if (!editor) return;
    editor.discard();
    article.innerHTML = savedInner;
    // The markup put back has lost what the runtime's buttons listened with.
    leave(true);
    say("Changes since the last save were put back");
  };
  const act = (action: EditAction): void => {
    if (action === "edit") begin();
    else if (action === "done") void finish();
    else if (action === "discard") discard();
    else if (editor) {
      article.focus();
      document.execCommand(action);
      article.dispatchEvent(new InputEvent("input", { inputType: action === "undo" ? "historyUndo" : "historyRedo" }));
    }
  };
  // A note's number, while editing, opens its text in the line to edit, and closes it again.
  article.addEventListener(
    "click",
    (e) => {
      const ref = editor ? (e.target as Element).closest?.(".fn-ref") : null;
      const note = ref?.previousElementSibling;
      if (!note?.classList.contains("fn")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      note.classList.toggle("fn-shown");
    },
    true,
  );
  addEventListener("message", (e) => {
    const m = (e.data ?? {}) as { __kos?: string; action?: EditAction };
    if (e.source === top && m.__kos === "edit-do" && m.action && article.isConnected) act(m.action);
  });
  document.addEventListener("keydown", (e) => {
    // The "/" menu takes its own Escape first.
    if (!editor || e.defaultPrevented) return;
    if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") || e.key === "Escape") {
      e.preventDefault();
      void finish();
    }
  });
  tell({});
}

/**
 * The contents beside the text stay in view as the dashboard scrolls the doc
 * past: a frame as tall as its doc never scrolls itself, so `sticky` has
 * nothing to stick to. The dashboard tells the doc where its view is (how far
 * down the frame the view's top is, and how tall the view is), and the
 * contents are moved to match, within the text beside them.
 */
function followView(): void {
  addEventListener("message", (e) => {
    const m = (e.data ?? {}) as { __kos?: string; top?: unknown; height?: unknown };
    if (e.source !== top || m.__kos !== "view" || typeof m.top !== "number" || typeof m.height !== "number") return;
    const toc = document.querySelector<HTMLElement>(".doc-toc");
    if (!toc) return;
    if (!matchMedia("(min-width: 1100px)").matches) {
      toc.style.transform = "";
      toc.style.maxHeight = "";
      return;
    }
    const shift = new DOMMatrixReadOnly(getComputedStyle(toc).transform === "none" ? undefined : getComputedStyle(toc).transform).m42;
    const natural = toc.getBoundingClientRect().top + scrollY - shift;
    const room = (toc.parentElement?.getBoundingClientRect().bottom ?? 0) + scrollY - natural - toc.offsetHeight;
    const y = Math.max(0, Math.min(m.top + 24 - natural, room));
    toc.style.transform = y > 0 ? `translateY(${Math.round(y)}px)` : "";
    toc.style.maxHeight = `${Math.max(160, Math.round(m.height - 48))}px`;
  });
}

export function startDoc(): void {
  const article = document.querySelector<HTMLElement>("article[data-doc]");
  if (!article) return;
  const start = (): Enhanced => enhance(article);
  followView();
  if (article.hasAttribute("data-locked") || !editable()) start();
  else editing(article, start);
}

// Inlined in a frame it runs as a script; imported by a test it waits to be called.
if (typeof document !== "undefined" && document.currentScript) {
  addStyle(DOC_CSS, "kos-doc-css");
  addStyle(EDIT_CSS, "kos-doc-edit-css");
  ready(startDoc);
}
