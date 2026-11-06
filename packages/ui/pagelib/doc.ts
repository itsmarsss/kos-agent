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
    const wide = typeof matchMedia === "function" && matchMedia("(min-width: 1100px)").matches;
    toc = el("nav", { class: "doc-toc", "aria-label": "Contents" }, el("details", { open: wide }, el("summary", {}, "Contents"), list));
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

/**
 * Edit, and editing: the doc becomes editable where it is (docedit.ts holds
 * the formats, the "/" menu and the markdown), each pause in typing saved as
 * a new version through kos.save, with undo and redo beside Done.
 */
function editing(article: HTMLElement, start: () => Enhanced): void {
  const bridge = kos();
  if (article.hasAttribute("data-locked") || !editable() || !bridge?.save) return;
  const save = bridge.save.bind(bridge);
  let enhanced = start();
  let editor: Editor | undefined;
  let last = "";
  const status = el("span", { class: "doc-status", role: "status", "aria-live": "polite" });
  const editBtn = el("button", { type: "button", title: "Edit the text in place" }, "Edit");
  const undoBtn = el("button", { type: "button", title: "Undo (Cmd+Z)", "aria-label": "Undo", hidden: true }, "↶");
  const redoBtn = el("button", { type: "button", title: "Redo (Shift+Cmd+Z)", "aria-label": "Redo", hidden: true }, "↷");
  const doneBtn = el("button", { type: "button", class: "primary", hidden: true }, "Done");
  const tools = el("div", { class: "doc-tools" }, status, undoBtn, redoBtn, doneBtn, editBtn);
  document.body.append(tools);
  const say = (text: string, bad = false): void => {
    status.textContent = text;
    status.classList.toggle("bad", bad);
  };
  const setEditing = (on: boolean): void => {
    editBtn.hidden = on;
    undoBtn.hidden = redoBtn.hidden = doneBtn.hidden = !on;
    document.documentElement.toggleAttribute("data-editing", on);
    if (on) {
      article.setAttribute("contenteditable", "true");
      article.setAttribute("spellcheck", "true");
      article.focus();
    } else {
      article.removeAttribute("contenteditable");
      article.removeAttribute("spellcheck");
    }
  };
  const begin = (): void => {
    enhanced.undo();
    last = cleanDocHtml(article);
    say("");
    setEditing(true);
    editor = startEditor(article, {
      say,
      // An edit that changes nothing is no version; the server refuses one anyway.
      save: async () => {
        const html = cleanDocHtml(article);
        if (html === last) return;
        await save({ doc: html });
        last = html;
      },
    });
  };
  const finish = async (): Promise<void> => {
    doneBtn.disabled = true;
    const stopped = (await editor?.stop()) ?? true;
    doneBtn.disabled = false;
    if (!stopped) return;
    editor = undefined;
    setEditing(false);
    enhanced = start();
  };
  editBtn.addEventListener("click", begin);
  doneBtn.addEventListener("click", () => void finish());
  for (const [btn, command] of [[undoBtn, "undo"], [redoBtn, "redo"]] as const) {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      document.execCommand(command);
      article.dispatchEvent(new InputEvent("input", { inputType: command === "undo" ? "historyUndo" : "historyRedo" }));
    });
  }
  document.addEventListener("keydown", (e) => {
    // The "/" menu takes its own Escape first.
    if (!editor || e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void finish();
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finish();
    }
  });
}

export function startDoc(): void {
  const article = document.querySelector<HTMLElement>("article[data-doc]");
  if (!article) return;
  const start = (): Enhanced => enhance(article);
  if (article.hasAttribute("data-locked") || !editable()) start();
  else editing(article, start);
}

// Inlined in a frame it runs as a script; imported by a test it waits to be called.
if (typeof document !== "undefined" && document.currentScript) {
  addStyle(DOC_CSS, "kos-doc-css");
  ready(startDoc);
}
