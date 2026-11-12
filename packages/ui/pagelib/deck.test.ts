// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialDeck, keyAction, noteLines, startDeck, step, tapAction, type DeckAction } from "./deck.js";

const run = (actions: DeckAction[], count = 4) => actions.reduce(step, initialDeck(count));

describe("deck navigation", () => {
  it("moves one slide at a time and stops at either end", () => {
    expect(run([{ type: "next" }, { type: "next" }]).index).toBe(2);
    expect(run([{ type: "prev" }]).index).toBe(0);
    expect(run([{ type: "last" }, { type: "next" }]).index).toBe(3);
    expect(run([{ type: "last" }, { type: "first" }]).index).toBe(0);
    expect(run([{ type: "go", index: 9 }]).index).toBe(3);
    expect(run([{ type: "go", index: -2 }]).index).toBe(0);
  });

  it("maps the keys a presenter reaches for", () => {
    expect(keyAction("ArrowRight")).toEqual({ type: "next" });
    expect(keyAction("PageDown")).toEqual({ type: "next" });
    expect(keyAction(" ")).toEqual({ type: "next" });
    expect(keyAction(" ", true)).toEqual({ type: "prev" });
    expect(keyAction("ArrowLeft")).toEqual({ type: "prev" });
    expect(keyAction("PageUp")).toEqual({ type: "prev" });
    expect(keyAction("Home")).toEqual({ type: "first" });
    expect(keyAction("End")).toEqual({ type: "last" });
    expect(keyAction("g")).toEqual({ type: "grid" });
    expect(keyAction("N")).toEqual({ type: "notes" });
    expect(keyAction("p")).toEqual({ type: "present" });
    expect(keyAction("x")).toBeUndefined();
  });

  it("opens the grid, jumps from it, and leaves it on Escape", () => {
    const grid = run([{ type: "grid" }]);
    expect(grid.grid).toBe(true);
    expect(step(grid, { type: "go", index: 2 })).toMatchObject({ grid: false, index: 2 });
    expect(step(grid, { type: "escape" }).grid).toBe(false);
  });

  it("presents, leaves the grid to do it, and Escape ends it", () => {
    const on = run([{ type: "grid" }, { type: "present", on: true }]);
    expect(on).toMatchObject({ presenting: true, grid: false });
    expect(step(on, { type: "escape" }).presenting).toBe(false);
    expect(step(on, { type: "present", on: false }).presenting).toBe(false);
    expect(step(initialDeck(3), { type: "escape" })).toEqual(initialDeck(3));
  });

  it("goes back on the left third of a slide and forward elsewhere", () => {
    expect(tapAction(10, 300)).toEqual({ type: "prev" });
    expect(tapAction(150, 300)).toEqual({ type: "next" });
  });
});

describe("kos-deck in a page", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
    document.body.removeAttribute("style");
    delete (window as { kos?: unknown }).kos;
  });

  const mount = (): HTMLElement[] => {
    document.body.innerHTML = `<main data-deck>
      <section class="title"><h1>Q3 review</h1><aside class="notes">Open with the headline.</aside></section>
      <section><h2>Revenue</h2><button>Inside</button></section>
      <section class="closing"><h2>Thanks</h2></section>
    </main>`;
    startDeck();
    return [...document.querySelectorAll<HTMLElement>("main section")];
  };
  const key = (k: string, shift = false): void => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
  };
  const button = (label: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>(".deck-bar button")].find((b) => b.textContent === label)!;

  it("shows one slide, counts, and moves by keys and buttons", () => {
    const slides = mount();
    expect(slides.map((s) => s.classList.contains("current"))).toEqual([true, false, false]);
    expect(document.querySelector(".deck-count")!.textContent).toBe("1 / 3");
    expect(button("←").disabled).toBe(true);
    key("ArrowRight");
    expect(slides[1]!.classList.contains("current")).toBe(true);
    expect(document.querySelector(".deck-count")!.textContent).toBe("2 / 3");
    button("→").click();
    expect(button("→").disabled).toBe(true);
    key("Home");
    expect(slides[0]!.classList.contains("current")).toBe(true);
  });

  it("shows the current slide's notes, and says when there are none", () => {
    mount();
    button("Notes").click();
    expect(document.body.classList.contains("deck-notes-on")).toBe(true);
    expect(document.querySelector(".deck-notes")!.textContent).toContain("Open with the headline.");
    key("ArrowRight");
    expect(document.querySelector(".deck-notes")!.textContent).toContain("No notes for this slide.");
  });

  it("opens the grid and jumps to a slide clicked in it", () => {
    const slides = mount();
    key("g");
    expect(document.body.classList.contains("deck-grid")).toBe(true);
    slides[2]!.querySelector("h2")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.classList.contains("deck-grid")).toBe(false);
    expect(slides[2]!.classList.contains("current")).toBe(true);
  });

  it("asks the dashboard to present, and follows kos:present", () => {
    const present = vi.fn();
    (window as { kos?: unknown }).kos = { present };
    mount();
    button("Present").click();
    expect(present).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("deck-present")).toBe(true);
    dispatchEvent(new CustomEvent("kos:present", { detail: { on: false } }));
    expect(document.body.classList.contains("deck-present")).toBe(false);
    dispatchEvent(new CustomEvent("kos:present", { detail: { on: true } }));
    expect(document.body.classList.contains("deck-present")).toBe(true);
    key("Escape");
    expect(document.body.classList.contains("deck-present")).toBe(false);
  });

  it("hands its bar to the dashboard that holds it, and moves as the dashboard asks", () => {
    const slides = mount();
    // In a test the window is its own top, as the dashboard is the frame's.
    const ask = (action: string): void => void dispatchEvent(new MessageEvent("message", { source: window, data: { __kos: "deck-do", action } }));
    expect(document.body.classList.contains("deck-hosted")).toBe(false);
    ask("host");
    expect(document.body.classList.contains("deck-hosted")).toBe(true);
    ask("next");
    expect(slides[1]!.classList.contains("current")).toBe(true);
    ask("notes");
    expect(document.body.classList.contains("deck-notes-on")).toBe(true);
    ask("grid");
    expect(document.body.classList.contains("deck-grid")).toBe(true);
    // Only what the dashboard may press.
    ask("present");
    expect(document.body.classList.contains("deck-present")).toBe(false);
  });

  it("goes to the slide the dashboard names, and leaves the grid to show it", () => {
    const slides = mount();
    const go = (index: unknown): void => void dispatchEvent(new MessageEvent("message", { source: window, data: { __kos: "deck-do", action: "go", index } }));
    key("g");
    go(2);
    expect(slides[2]!.classList.contains("current")).toBe(true);
    expect(document.body.classList.contains("deck-grid")).toBe(false);
    // Past the end stops at it; anything but a whole number is not a place.
    go(9);
    expect(slides[2]!.classList.contains("current")).toBe(true);
    go("0");
    go(0.5);
    expect(slides[2]!.classList.contains("current")).toBe(true);
    go(0);
    expect(slides[0]!.classList.contains("current")).toBe(true);
  });

  it("hears a go only from the window holding it", () => {
    const slides = mount();
    dispatchEvent(new MessageEvent("message", { source: null, data: { __kos: "deck-do", action: "go", index: 2 } }));
    expect(slides[0]!.classList.contains("current")).toBe(true);
  });

  it("puts each slide in a frame of its own and takes Enter in the grid to open one", () => {
    const slides = mount();
    expect(slides.every((s) => s.parentElement!.classList.contains("deck-slide"))).toBe(true);
    expect(slides[0]!.parentElement!.classList.contains("current")).toBe(true);
    key("g");
    key("ArrowRight");
    key("Enter");
    expect(document.body.classList.contains("deck-grid")).toBe(false);
    expect(slides[1]!.classList.contains("current")).toBe(true);
  });

  it("leaves keys alone when they are typed into a control", () => {
    const slides = mount();
    const button = slides[1]!.querySelector("button")!;
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(slides[0]!.classList.contains("current")).toBe(true);
  });
});

describe("a slide's notes as text", () => {
  const notes = (html: string): Element => {
    const aside = document.createElement("aside");
    aside.innerHTML = html;
    return aside;
  };

  it("says a block a line, items with a bullet, loose text a line of its own", () => {
    expect(noteLines(notes("Open with the <b>headline</b>."))).toEqual(["Open with the headline."]);
    expect(noteLines(notes("<p>First,  the\n number.</p><ul><li>Then <em>why</em></li><li><p>And what next</p></li></ul>Close."))).toEqual(["First, the number.", "\u2022 Then why", "\u2022 And what next", "Close."]);
    expect(noteLines(notes("One<br>Two"))).toEqual(["One", "Two"]);
  });

  it("says nothing for no notes, and never a script's or a style's text", () => {
    expect(noteLines(null)).toEqual([]);
    expect(noteLines(notes("<p> </p><li></li>"))).toEqual([]);
    expect(noteLines(notes("<style>p{}</style><script>x()</script><p>Said</p>"))).toEqual(["Said"]);
  });

  it("keeps a report small: at most sixty lines, each cut", () => {
    const lines = noteLines(notes(`${"<p>line</p>".repeat(80)}<p>${"x".repeat(3000)}</p>`));
    expect(lines).toHaveLength(60);
    expect(noteLines(notes(`<p>${"x".repeat(3000)}</p>`))[0]).toHaveLength(2000);
  });
});
