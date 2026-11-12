/**
 * kos-deck: slides from plain sections. The agent writes one
 * `<main data-deck>` with a `<section>` per slide (and an `<aside
 * class="notes">` in a slide for what to say); this shows one slide at a
 * time fitted to the frame, and gives keys, buttons, taps and swipes to move,
 * a counter, a grid of every slide, the notes, and presenting. Sizes are in
 * slide units (deck.css.ts), so nothing is scaled by script.
 *
 * Where the deck is (which slide, which view) is a small state machine,
 * kept pure below so it is tested apart from the page.
 */

import { DECK_CSS } from "./deck.css.js";
import { addStyle, el, interactive, keepRanges, kos, ready } from "./runtime.js";

export interface DeckState {
  index: number;
  count: number;
  grid: boolean;
  notes: boolean;
  presenting: boolean;
}

/**
 * What the deck tells the dashboard holding it, after every change, so the
 * dashboard's own head can draw the deck's controls (ArtifactPage.tsx).
 */
export interface DeckReport {
  __kos: "deck";
  index: number;
  count: number;
  grid: boolean;
  notes: boolean;
  /** A phone held upright: the slides stack to be read, with nothing to move between. */
  reading: boolean;
  /** The dashboard draws the controls, so the deck's own bar is away. */
  hosted: boolean;
  /** The current slide's notes as plain text, a block a line, for the presenter view to set as text. */
  said: string[];
  /**
   * Where the slide came from: the `seq` of the last `go` it obeyed, 0 when
   * it was never told one, or null once it moved on its own since (a key, a
   * tap). The presenter view tells a report of its latest go from one sent
   * before it landed, and both from the deck moving by itself.
   */
  went: number | null;
}

/**
 * What the dashboard asks of the deck: to take over its bar, what the owner
 * pressed in it, or `go` with an `index` and a `seq`, which the presenter view sends to
 * keep its slides and the audience's on one place.
 */
export type DeckDo = "host" | "prev" | "next" | "grid" | "notes" | "go";

/** At most this many blocks of a slide's notes, each cut to this many characters: a report stays small. */
const SAID_BLOCKS = 60;
const SAID_CHARS = 2000;
/** What starts a line of its own in a slide's notes; anything else runs on in the line it is in. */
const BLOCK = /^(P|LI|H[1-6]|BLOCKQUOTE|PRE|DT|DD|UL|OL|DL|DIV|SECTION|FIGURE|TABLE|TR|BR)$/;

/**
 * A slide's notes as plain text, a block a line: each paragraph, heading or
 * list item (a bullet before an item), loose text a line of its own. Never
 * markup: the dashboard sets these as text.
 */
export function noteLines(notes: Element | null | undefined): string[] {
  const lines: string[] = [];
  let run = "";
  // A list item's bullet, for the first line said in it.
  let lead = "";
  const flush = (): void => {
    const line = run.replace(/\s+/g, " ").trim().slice(0, SAID_CHARS);
    run = "";
    if (line === "") return;
    lines.push(`${lead}${line}`);
    lead = "";
  };
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) run += child.textContent ?? "";
      else if (child.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|TEMPLATE)$/.test((child as Element).tagName)) continue;
      else if (BLOCK.test((child as Element).tagName)) {
        flush();
        if ((child as Element).tagName === "LI") lead = "\u2022 ";
        walk(child);
        flush();
        lead = "";
      } else walk(child);
    }
  };
  if (notes) walk(notes);
  flush();
  return lines.slice(0, SAID_BLOCKS);
}

export type DeckAction =
  | { type: "next" | "prev" | "first" | "last" | "grid" | "notes" | "escape" }
  | { type: "go"; index: number }
  | { type: "present"; on?: boolean };

export const initialDeck = (count: number): DeckState => ({ index: 0, count, grid: false, notes: false, presenting: false });

const clamp = (i: number, count: number): number => Math.max(0, Math.min(count - 1, i));

/** Where an action takes the deck. Moving stops at either end; Escape leaves the grid first, then presenting. */
export function step(s: DeckState, a: DeckAction): DeckState {
  switch (a.type) {
    case "next":
      return { ...s, index: clamp(s.index + 1, s.count) };
    case "prev":
      return { ...s, index: clamp(s.index - 1, s.count) };
    case "first":
      return { ...s, index: 0 };
    case "last":
      return { ...s, index: clamp(s.count - 1, s.count) };
    case "go":
      return { ...s, index: clamp(a.index, s.count), grid: false };
    case "grid":
      return { ...s, grid: !s.grid, presenting: false };
    case "notes":
      return { ...s, notes: !s.notes };
    case "present": {
      const on = a.on ?? !s.presenting;
      return { ...s, presenting: on, grid: on ? false : s.grid };
    }
    case "escape":
      if (s.grid) return { ...s, grid: false };
      if (s.presenting) return { ...s, presenting: false };
      return s;
  }
}

/** The action a key stands for, or none. */
export function keyAction(key: string, shift = false): DeckAction | undefined {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return { type: "next" };
    case " ":
    case "Spacebar":
      return { type: shift ? "prev" : "next" };
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return { type: "prev" };
    case "Home":
      return { type: "first" };
    case "End":
      return { type: "last" };
    case "Escape":
      return { type: "escape" };
    case "g":
    case "G":
      return { type: "grid" };
    case "n":
    case "N":
      return { type: "notes" };
    case "p":
    case "P":
    case "f":
    case "F":
      return { type: "present" };
    default:
      return undefined;
  }
}

/** A tap at x across a slide of this width: the left third goes back, the rest forward. */
export const tapAction = (x: number, width: number): DeckAction => ({ type: x < width / 3 ? "prev" : "next" });

/** Whether the frame is a phone held upright, where slides stack to be read. */
const READ_QUERY = "(max-width: 640px) and (orientation: portrait)";

export function startDeck(): void {
  const deck = document.querySelector<HTMLElement>("main[data-deck]");
  if (!deck) return;
  const slides = [...deck.children].filter((c): c is HTMLElement => c.tagName === "SECTION");
  if (!slides.length) return;
  let state = initialDeck(slides.length);
  let reading = typeof matchMedia === "function" && matchMedia(READ_QUERY).matches;

  // Ranges of figures ("Ch. 1–6") stay on one line; a deck is not edited, so the spans are never saved.
  keepRanges(deck, "h1, h2, h3, h4, p, li, td, th, figcaption, .kicker, .big");
  deck.setAttribute("aria-roledescription", "slide deck");
  // Each slide in a frame that is its size container, so its own padding and type scale with it.
  const frames = slides.map((s, i) => {
    s.setAttribute("aria-roledescription", "slide");
    s.setAttribute("aria-label", `${i + 1} of ${slides.length}`);
    const frame = el("div", { class: "deck-slide", "data-number": String(i + 1) });
    s.replaceWith(frame);
    frame.append(s);
    return frame;
  });

  const prev = el("button", { type: "button", "aria-label": "Previous slide" }, "←");
  const next = el("button", { type: "button", "aria-label": "Next slide" }, "→");
  const count = el("span", { class: "deck-count", role: "status", "aria-live": "polite" });
  const gridBtn = el("button", { type: "button", "aria-pressed": "false", title: "All slides (G)" }, "Grid");
  const notesBtn = el("button", { type: "button", "aria-pressed": "false", title: "Presenter notes (N)" }, "Notes");
  const presentBtn = el("button", { type: "button", title: "Present (P)" }, "Present");
  const bar = el("nav", { class: "deck-bar", "aria-label": "Slides" }, prev, count, next, el("span", { class: "deck-spacer" }), notesBtn, gridBtn, presentBtn);
  const notes = el("aside", { class: "deck-notes", "aria-label": "Presenter notes" });
  document.body.append(notes, bar);

  const render = (): void => {
    const b = document.body.classList;
    b.toggle("deck-read", reading);
    b.toggle("deck-grid", state.grid && !reading);
    b.toggle("deck-present", state.presenting && !reading);
    b.toggle("deck-notes-on", state.notes && !state.grid && !reading);
    slides.forEach((s, i) => {
      const frame = frames[i]!;
      s.classList.toggle("current", i === state.index);
      frame.classList.toggle("current", i === state.index);
      if (state.grid) frame.setAttribute("tabindex", "0");
      else frame.removeAttribute("tabindex");
      frame.setAttribute("aria-hidden", String(!state.grid && !reading && i !== state.index));
    });
    count.textContent = `${state.index + 1} / ${state.count}`;
    prev.disabled = state.index === 0;
    next.disabled = state.index === state.count - 1;
    gridBtn.setAttribute("aria-pressed", String(state.grid));
    notesBtn.setAttribute("aria-pressed", String(state.notes));
    const said = slides[state.index]!.querySelector("aside.notes");
    notes.replaceChildren(el("span", { class: "deck-notes-label" }, `Notes, slide ${state.index + 1}`), ...(said ? [...said.childNodes].map((n) => n.cloneNode(true)) : [el("span", { class: "deck-notes-none" }, "No notes for this slide.")]));
    if (state.grid) frames[state.index]!.scrollIntoView?.({ block: "nearest" });
    report();
  };
  /*
   * Inside the dashboard the deck's controls are the dashboard's, in the
   * viewer's head: the deck says where it is, and the dashboard says what was
   * pressed. Standalone (a check's render, a file opened on its own), the
   * deck keeps its own bar.
   */
  let hosted = false;
  const report = (): void => {
    if (window.top === window) return;
    const told: DeckReport = { __kos: "deck", index: state.index, count: state.count, grid: state.grid, notes: state.notes, reading, hosted, said: noteLines(slides[state.index]!.querySelector("aside.notes")), went };
    top?.postMessage(told, "*");
  };
  const host = (): void => {
    if (hosted) return;
    hosted = true;
    // Its bar and its notes are the dashboard's now, and the slide fills the frame: the dashboard sizes the frame to it.
    document.body.classList.add("deck-hosted");
  };
  let went: number | null = 0;
  const apply = (a: DeckAction, seq?: number): void => {
    const was = state.presenting;
    const at = state.index;
    state = step(state, a);
    if (seq !== undefined) went = seq;
    else if (state.index !== at) went = null;
    // Asking the dashboard for the whole screen; it tells the deck back through kos:present.
    if (a.type === "present" && state.presenting && !was) kos()?.present?.();
    // And giving it back when the deck stops on its own (Escape, the grid), so the dashboard does not hold a screen nobody presents on.
    else if (was && !state.presenting) kos()?.present?.(false);
    render();
  };

  prev.addEventListener("click", () => apply({ type: "prev" }));
  next.addEventListener("click", () => apply({ type: "next" }));
  gridBtn.addEventListener("click", () => apply({ type: "grid" }));
  notesBtn.addEventListener("click", () => apply({ type: "notes" }));
  presentBtn.addEventListener("click", () => apply({ type: "present", on: true }));

  document.addEventListener("keydown", (e) => {
    if (reading || e.metaKey || e.ctrlKey || e.altKey || interactive(e.target)) return;
    if (state.grid && e.key === "Enter") {
      e.preventDefault();
      apply({ type: "go", index: state.index });
      return;
    }
    const a = keyAction(e.key, e.shiftKey);
    if (!a) return;
    e.preventDefault();
    apply(a);
  });

  deck.addEventListener("click", (e) => {
    if (reading) return;
    const slide = (e.target as Element).closest?.(".deck-slide");
    if (!slide || slide.parentElement !== deck) return;
    if (state.grid) {
      apply({ type: "go", index: frames.indexOf(slide as HTMLDivElement) });
      return;
    }
    if (interactive(e.target) || (getSelection()?.toString() ?? "") !== "") return;
    const r = slide.getBoundingClientRect();
    apply(tapAction(e.clientX - r.left, r.width));
  });

  let touch: { x: number; y: number } | undefined;
  deck.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    touch = t ? { x: t.clientX, y: t.clientY } : undefined;
  }, { passive: true });
  deck.addEventListener("touchend", (e) => {
    const t = e.changedTouches[0];
    if (!touch || !t || reading || state.grid) return;
    const dx = t.clientX - touch.x;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(t.clientY - touch.y) * 1.5) {
      e.preventDefault();
      apply({ type: dx < 0 ? "next" : "prev" });
    }
    touch = undefined;
  });

  addEventListener("message", (e) => {
    const m = (e.data ?? {}) as { __kos?: string; action?: DeckDo; index?: unknown; seq?: unknown };
    if (e.source !== top || m.__kos !== "deck-do") return;
    if (m.action === "host") {
      host();
      render();
    } else if (m.action === "go") {
      if (typeof m.index === "number" && Number.isInteger(m.index)) apply({ type: "go", index: m.index }, typeof m.seq === "number" && Number.isInteger(m.seq) && m.seq > 0 ? m.seq : undefined);
    } else if (m.action === "prev" || m.action === "next" || m.action === "grid" || m.action === "notes") apply({ type: m.action });
  });
  addEventListener("kos:present", (e) => apply({ type: "present", on: (e as CustomEvent<{ on?: boolean }>).detail?.on === true }));
  if (typeof matchMedia === "function") {
    matchMedia(READ_QUERY).addEventListener?.("change", (m) => {
      reading = m.matches;
      render();
    });
  }
  if (document.documentElement.dataset.present === "on") state = step(state, { type: "present", on: true });
  render();
}

// Inlined in a frame it runs as a script; imported by a test it waits to be called.
if (typeof document !== "undefined" && document.currentScript) {
  addStyle(DECK_CSS, "kos-deck-css");
  ready(startDeck);
}
