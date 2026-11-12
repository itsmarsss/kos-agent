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
import { ARTIFACT_ID_RE, DOC_EDIT_MAX } from "@kos/shared/artifacts";

import { ensureTodoBoxes, toggleTodo } from "./docblocks.js";
import { saveQueue, startEditor, type Editor } from "./docedit.js";
import { setView } from "./docui.js";
import { addStyle, editable, el, keepRanges, kos, ready, reducedMotion } from "./runtime.js";

/** Whether a click is the owner's own; a test stands in for the browser here, which alone makes trusted events. */
export const clicks = { trusted: (e: Event): boolean => e.isTrusted };

/** Where the doc says something to the owner outside editing (the head's status, once the doc can be edited); nowhere until then. */
let notice: (text: string) => void = () => undefined;

/** How many h2s make a document long enough for a table of contents. */
export const TOC_MIN = 4;

const GEN = "data-kos-gen";
const GEN_ID = "data-kos-gen-id";
const GEN_ATTRS = "data-kos-gen-attrs";

/** Give an element of the agent's an attribute of the runtime's, taken off again before a save. */
function genAttr(node: Element, name: string, value: string): void {
  if (node.hasAttribute(name) && !(node.getAttribute(GEN_ATTRS) ?? "").split(" ").includes(name)) return;
  node.setAttribute(name, value);
  const names = new Set((node.getAttribute(GEN_ATTRS) ?? "").split(" ").filter(Boolean)).add(name);
  node.setAttribute(GEN_ATTRS, [...names].join(" "));
}
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
  // Attributes the runtime put on the agent's own elements (a chip's role), named on the element.
  for (const node of [...root.querySelectorAll(`[${GEN_ATTRS}]`)]) {
    for (const name of (node.getAttribute(GEN_ATTRS) ?? "").split(" ")) if (name) node.removeAttribute(name);
    node.removeAttribute(GEN_ATTRS);
  }
  for (const node of [...root.querySelectorAll(`[${GEN_ID}]`)]) {
    node.removeAttribute("id");
    node.removeAttribute(GEN_ID);
  }
  root.querySelectorAll(".fn-shown").forEach((n) => n.classList.remove("fn-shown"));
  root.querySelectorAll("[data-kos-ph]").forEach((n) => n.removeAttribute("data-kos-ph"));
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
  // The editor's zero-width step out of a mark just typed is no character of the doc's.
  const walker = copy.ownerDocument.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes("\u200b")) (n as Text).data = (n as Text).data.replace(/\u200b/g, "");
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

  // Ranges of figures stay on one line, unwrapped again before anything is saved or compared.
  keepRanges(article, "h1, h2, h3, h4, .kicker, .lede, th, td, figcaption, li", (span) => span.setAttribute(GEN, WRAP));

  // To-dos get a box to tick, by pointer or by key; a mention of another artifact is a link to it.
  ensureTodoBoxes(article);
  for (const chip of article.querySelectorAll(".mention[data-artifact]")) {
    genAttr(chip, "role", "link");
    genAttr(chip, "tabindex", "0");
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
  let unfollow: (() => void) | undefined;
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
      const query = matchMedia("(min-width: 1100px)");
      const follow = (): void => {
        fold.open = query.matches;
      };
      follow();
      query.addEventListener("change", follow);
      unfollow = () => query.removeEventListener("change", follow);
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
      unfollow?.();
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
  const queue = saveQueue();
  let enhanced = start();
  let editor: Editor | undefined;
  /** The article as last saved (or as editing began), to put back on Discard; and its clean HTML, to skip a save that changes nothing. */
  let savedInner = "";
  let last = cleanDocHtml(article);
  const state: EditState = { __kos: "edit", editing: false, pending: false, status: "", bad: false };
  const tell = (change: Partial<EditState>): void => {
    Object.assign(state, change);
    top?.postMessage({ ...state }, "*");
  };
  const say = (status: string, bad = false): void => tell({ status, bad });
  notice = (text) => say(text, true);
  /** The doc as editing began, so leaving redraws its contents and notes only when something changed. */
  let began = "";
  /** Typed into since editing began: even a deleted note number, which the saved text never holds, needs the notes numbered again. */
  let typed = false;
  article.addEventListener("input", () => {
    if (editor) typed = true;
  });

  let starting = false;
  /** A Done or Discard pressed while Edit waited on a tick: editing does not start after all. */
  let cancelled = false;
  const begin = async (): Promise<void> => {
    if (editor) return;
    // Edit again while waiting: it stands, even after a Done or Discard pressed in the wait.
    if (starting) {
      cancelled = false;
      return;
    }
    // A tick still waiting is kept first, so the snapshot editing starts from is the doc as saved with it.
    if (unkept || tickBusy) {
      starting = true;
      cancelled = false;
      if (unkept) await flushTicks();
      else await ticking;
      starting = false;
      if (editor || cancelled) return;
    }
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
      queue,
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
    cancelled = true;
    // Not editing: Done (or the frame going) waits for a tick still to be kept.
    if (!editor) {
      await ticking;
      if (unkept) await flushTicks();
      return;
    }
    if (await editor.stop()) leave();
  };
  const discard = (): void => {
    cancelled = true;
    if (!editor) return;
    editor.discard();
    article.innerHTML = savedInner;
    // The markup put back has lost what the runtime's buttons listened with.
    leave(true);
    say("Changes since the last save were put back");
  };
  const act = (action: EditAction): void => {
    if (action === "edit") void begin();
    else if (action === "done") void finish();
    else if (action === "discard") discard();
    else if (editor) {
      article.focus();
      editor[action]();
    }
  };
  // Reading, a to-do is ticked where it is and kept at once: the tick goes onto the doc as last saved, never the live article
  // (a toggle opened, a chart drawn into it), in the same line of saves as editing's.
  /** A tick made while reading and not yet kept. */
  let unkept = false;
  let ticking: Promise<boolean> = Promise.resolve(true);
  /** A tick's save waiting its turn or out. */
  let tickBusy = false;
  const flushTicks = (): Promise<boolean> => {
    tickBusy = true;
    const run = (ticking = queue.run(async () => {
      unkept = false;
      const base = document.createElement("template");
      base.innerHTML = last;
      const items = [...base.content.querySelectorAll("ul.checklist > li")];
      const live = [...article.querySelectorAll("ul.checklist > li")];
      if (items.length !== live.length) {
        tell({ pending: false });
        say("Not saved: the doc changed since it was drawn; reload it to tick this", true);
        return false;
      }
      // Every item's state as it stands, so a tick a refused save left behind goes with the next.
      live.forEach((li, i) => items[i]!.setAttribute("data-checked", li.getAttribute("data-checked") === "true" ? "true" : "false"));
      const html = base.innerHTML;
      if (html === last) {
        tell({ pending: unkept });
        return true;
      }
      say("Saving…");
      return save({ doc: html }).then(
        () => {
          last = html;
          tell({ pending: unkept });
          say("Saved");
          return true;
        },
        (err: unknown) => {
          unkept = true;
          tell({ pending: true });
          say(`Not saved: ${err instanceof Error ? err.message : String(err)}`, true);
          return false;
        },
      );
    }, () => !unkept));
    void run.finally(() => {
      if (ticking === run) tickBusy = false;
    });
    return run;
  };
  article.addEventListener("click", (e) => {
    const box = editor || !clicks.trusted(e) ? null : (e.target as Element).closest?.(".todo-box");
    if (!box || !article.contains(box)) return;
    e.preventDefault();
    toggleTodo(box.parentElement!);
    ensureTodoBoxes(article);
    unkept = true;
    tell({ pending: true });
    void flushTicks();
  });
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
    setView(m.top, m.height);
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
  // A mention opens what it names, in the dashboard, which knows where that is; never while its words are being edited.
  const open = (e: Event): void => {
    const chip = (e.target as Element).closest?.(".mention[data-artifact]");
    if (!chip || article.getAttribute("contenteditable") === "true") return;
    if (e instanceof KeyboardEvent && e.key !== "Enter") return;
    e.preventDefault();
    const id = chip.getAttribute("data-artifact") ?? "";
    // A refused open is said quietly in the head, where the doc's status goes.
    if (ARTIFACT_ID_RE.test(id)) void kos()?.open?.(id).catch((err: unknown) => notice(`Not opened: ${err instanceof Error ? err.message : String(err)}`));
  };
  article.addEventListener("click", open);
  article.addEventListener("keydown", open);
  if (article.hasAttribute("data-locked") || !editable()) {
    start();
    article.querySelectorAll(".todo-box").forEach((b) => b.setAttribute("disabled", ""));
  } else editing(article, start);
}

// Inlined in a frame it runs as a script; imported by a test it waits to be called.
if (typeof document !== "undefined" && document.currentScript) {
  addStyle(DOC_CSS, "kos-doc-css");
  addStyle(EDIT_CSS, "kos-doc-edit-css");
  ready(startDoc);
}
