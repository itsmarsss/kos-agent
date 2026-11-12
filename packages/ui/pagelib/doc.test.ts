// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOC_MIN, cleanDocHtml, clicks, enhance, slugOf, startDoc } from "./doc.js";
import { DOC_EDIT_MAX } from "@kos/shared/artifacts";

import { AUTOSAVE_GAP_MS, AUTOSAVE_MS, IMAGE_MAX, inlineMark, saveQueue, shortcutOf, slashMatches } from "./docedit.js";

const ARTICLE = `<header><p class="kicker">Plan</p><h1>Garden plan</h1><p class="lede">What goes where.</p></header>
<h2>Beds</h2><p>Three beds<span class="fn">Each 1.2 m by 3 m.</span> along the fence.</p>
<h2>Soil</h2><p>Compost first.<span class="fn">From the <em>council</em> depot.</span></p>
<table><tr><td>Tomato</td><td class="num">6</td></tr></table>
<figure><svg></svg><figcaption>The beds.</figcaption></figure>`;

function mount(inner: string, attrs = ""): HTMLElement {
  document.body.innerHTML = `<article data-doc ${attrs}>${inner}</article>`;
  return document.querySelector("article")!;
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as { kos?: unknown }).kos;
});

describe("kos-doc", () => {
  it("numbers footnotes and lists them after the article", () => {
    const article = mount(ARTICLE);
    enhance(article);
    const refs = [...article.querySelectorAll(".fn-ref")].map((r) => r.textContent);
    expect(refs).toEqual(["1", "2"]);
    const notes = document.querySelectorAll(".doc-notes li");
    expect(notes).toHaveLength(2);
    expect(notes[1]!.textContent).toContain("From the council depot.");
    expect(notes[1]!.querySelector("em")).not.toBeNull();
    expect(article.nextElementSibling?.classList.contains("doc-notes")).toBe(true);
  });

  it("keeps a range of figures on one line, and never stores the span that does it", () => {
    const article = mount(`<header><h1>BU354 Ch. 1–6 Cram Sheet</h1><p class="lede">Weeks 3 – 5 and pages 10–12.</p></header><p>Chapters 1–6 in a paragraph stay as written.</p><ul><li>Rows 2–4</li></ul>`);
    const stored = article.innerHTML;
    enhance(article);
    expect([...article.querySelectorAll(".nowrap")].map((n) => n.textContent)).toEqual(["1–6", "3 – 5", "10–12", "2–4"]);
    expect(cleanDocHtml(article)).toBe(stored.trim());
  });

  it("gives headings ids, wraps tables, and makes no links", () => {
    const article = mount(ARTICLE);
    enhance(article);
    expect([...article.querySelectorAll("h2")].map((h) => h.id)).toEqual(["beds", "soil"]);
    expect(article.querySelector("table")!.parentElement!.classList.contains("doc-table")).toBe(true);
    expect(document.querySelector("a[href]")).toBeNull();
  });

  it("builds contents only for a long document", () => {
    enhance(mount(ARTICLE));
    expect(document.querySelector(".doc-toc")).toBeNull();
    const long = Array.from({ length: TOC_MIN }, (_, i) => `<h2>Part ${i + 1}</h2><h3>Detail</h3><p>Text.</p>`).join("");
    enhance(mount(long));
    const items = [...document.querySelectorAll(".doc-toc li")];
    expect(items).toHaveLength(TOC_MIN * 2);
    expect(items[1]!.classList.contains("sub")).toBe(true);
    expect(document.querySelector(".doc-frame")!.classList.contains("has-toc")).toBe(true);
  });

  it("keeps an id the author gave and makes the rest unique", () => {
    const taken = new Set<string>();
    expect(slugOf("Costs & Risks!", taken)).toBe("costs-risks");
    expect(slugOf("Costs & Risks", taken)).toBe("costs-risks-2");
    const article = mount(`<h2 id="mine">One</h2><h2>One</h2>`);
    enhance(article);
    expect(article.querySelector("h2")!.id).toBe("mine");
    expect(cleanDocHtml(article)).toContain('id="mine"');
  });

  it("serialises the article as written: nothing generated, footnotes in place", () => {
    const article = mount(ARTICLE);
    enhance(article);
    article.setAttribute("contenteditable", "true");
    const html = cleanDocHtml(article);
    expect(html).not.toContain("data-kos-gen");
    expect(html).not.toContain("fn-ref");
    expect(html).not.toContain("doc-table");
    expect(html).not.toContain('id="beds"');
    expect(html).not.toContain("contenteditable");
    expect(html).toContain('<span class="fn">Each 1.2 m by 3 m.</span>');
    expect(html).toContain("<table>");
    // The live article is untouched by serialising.
    expect(article.querySelectorAll(".fn-ref")).toHaveLength(2);
  });

  /** What the doc told the dashboard about its editing, last first. */
  const states = (spy: ReturnType<typeof vi.spyOn>): { editing: boolean; pending: boolean; status: string }[] =>
    spy.mock.calls.map((c) => c[0] as { __kos?: string }).filter((m): m is never => m.__kos === "edit").reverse();
  /** The viewer's head, pressed. */
  const press = (action: string): void => void window.dispatchEvent(new MessageEvent("message", { source: window, data: { __kos: "edit-do", action } }));

  it("offers editing to the dashboard only with kos.save, and not when locked", () => {
    const told = vi.spyOn(window, "postMessage");
    mount(ARTICLE);
    startDoc();
    expect(states(told)).toEqual([]);
    (window as { kos?: unknown }).kos = { save: vi.fn() };
    mount(ARTICLE, "data-locked");
    startDoc();
    expect(states(told)).toEqual([]);
    mount(ARTICLE);
    startDoc();
    expect(states(told)[0]).toMatchObject({ editing: false, pending: false });
    told.mockRestore();
  });

  it("saves an edit as the article's clean HTML when the owner is done, then draws the doc again", async () => {
    const save = vi.fn().mockResolvedValue({ version: 2 });
    (window as { kos?: unknown }).kos = { save };
    document.execCommand = vi.fn() as typeof document.execCommand;
    const told = vi.spyOn(window, "postMessage");
    const article = mount(ARTICLE);
    startDoc();

    press("edit");
    expect(article.getAttribute("contenteditable")).toBe("true");
    // Laid out as it reads: the notes keep their numbers, never typed into, and the list at the end stays.
    const refs = [...article.querySelectorAll(".fn-ref")];
    expect(refs.map((r) => r.getAttribute("contenteditable"))).toEqual(["false", "false"]);
    expect(document.querySelector(".doc-notes")).not.toBeNull();
    // A number opens its note in the line to edit, and closes it again.
    const note = article.querySelector(".fn")!;
    (refs[0] as HTMLElement).click();
    expect(note.classList.contains("fn-shown")).toBe(true);
    (refs[0] as HTMLElement).click();
    expect(note.classList.contains("fn-shown")).toBe(false);
    expect(states(told)[0]).toMatchObject({ editing: true });
    // Done with nothing changed saves nothing.
    press("done");
    await vi.waitFor(() => expect(article.hasAttribute("contenteditable")).toBe(false));
    expect(save).not.toHaveBeenCalled();

    press("edit");
    article.querySelector("h1")!.textContent = "Garden plan, revised";
    article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "d" }));
    expect(states(told)[0]).toMatchObject({ editing: true, pending: true });
    press("done");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![0] as { doc: string };
    expect(sent.doc).toContain("<h1>Garden plan, revised</h1>");
    expect(sent.doc).toContain('<span class="fn">Each 1.2 m by 3 m.</span>');
    expect(sent.doc).not.toContain("data-kos-gen");
    expect(sent.doc).not.toContain("fn-shown");
    expect(sent.doc).not.toContain("contenteditable");
    await vi.waitFor(() => expect(article.hasAttribute("contenteditable")).toBe(false));
    expect(states(told)[0]).toMatchObject({ editing: false, pending: false });
    expect(states(told).some((s) => s.status === "Saved")).toBe(true);
    expect(article.querySelectorAll(".fn-ref")).toHaveLength(2);
    told.mockRestore();
  });

  it("saves an edit with no trace of the spans that keep a range together, and counts them as no change", async () => {
    const save = vi.fn().mockResolvedValue({ version: 2 });
    (window as { kos?: unknown }).kos = { save };
    document.execCommand = vi.fn() as typeof document.execCommand;
    const article = mount(`<header><h1>BU354 Ch. 1–6 Cram Sheet</h1></header><h2>Weeks 3–5</h2><p>Read it twice.</p>`);
    startDoc();
    expect(article.querySelectorAll(".nowrap")).toHaveLength(2);
    press("edit");
    press("done");
    await vi.waitFor(() => expect(article.hasAttribute("contenteditable")).toBe(false));
    expect(save).not.toHaveBeenCalled();
    press("edit");
    article.querySelector("p")!.textContent = "Read it three times.";
    article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "s" }));
    press("done");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = (save.mock.calls[0]![0] as { doc: string }).doc;
    expect(sent).toContain("<h1>BU354 Ch. 1–6 Cram Sheet</h1>");
    expect(sent).toContain("<h2>Weeks 3–5</h2>");
    expect(sent).not.toContain("nowrap");
  });

  it("numbers its notes again on leaving when a number was deleted, though the saved text is the same", async () => {
    (window as { kos?: unknown }).kos = { save: vi.fn().mockResolvedValue({ version: 2 }) };
    document.execCommand = vi.fn() as typeof document.execCommand;
    const article = mount(ARTICLE);
    startDoc();
    press("edit");
    article.querySelector(".fn-ref")!.remove();
    article.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward" }));
    press("done");
    await vi.waitFor(() => expect(article.hasAttribute("contenteditable")).toBe(false));
    expect(article.querySelectorAll(".fn-ref")).toHaveLength(2);
  });

  it("saves on its own a moment after the owner stops typing, and Done just after a save waits out the gap rather than being refused", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn().mockResolvedValue({ version: 2 });
      (window as { kos?: unknown }).kos = { save };
      const article = mount(ARTICLE);
      startDoc();
      press("edit");
      for (const word of [" one", " two", " three"]) {
        article.querySelector("p")!.append(word);
        article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "e" }));
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(save).toHaveBeenCalledTimes(1);
      expect((save.mock.calls[0]![0] as { doc: string }).doc).toContain("one two three");
      // A keystroke and Done at once: the save waits for the gap, then goes; it is never sent inside it.
      article.querySelector("p")!.append(" four");
      article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "r" }));
      press("done");
      await vi.advanceTimersByTimeAsync(AUTOSAVE_GAP_MS - 700);
      expect(save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(save).toHaveBeenCalledTimes(2);
      expect((save.mock.calls[1]![0] as { doc: string }).doc).toContain("four");
      await vi.advanceTimersByTimeAsync(10);
      expect(article.hasAttribute("contenteditable")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never starts a second save while one is out", async () => {
    let finish: () => void = () => undefined;
    const save = vi.fn().mockImplementation(() => new Promise<void>((r) => (finish = r)));
    (window as { kos?: unknown }).kos = { save };
    vi.useFakeTimers();
    try {
      const article = mount(ARTICLE);
      startDoc();
      press("edit");
      article.querySelector("p")!.append(" one");
      article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "e" }));
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(save).toHaveBeenCalledTimes(1);
      article.querySelector("p")!.append(" two");
      article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "o" }));
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + AUTOSAVE_GAP_MS * 2);
      expect(save).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_GAP_MS + 10);
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why a save was refused and stays in editing, and Discard puts back what was not saved", async () => {
    (window as { kos?: unknown }).kos = { save: vi.fn().mockRejectedValue(new Error("the edit holds a script")) };
    const told = vi.spyOn(window, "postMessage");
    const article = mount(ARTICLE);
    startDoc();
    const before = article.querySelector("p")!.textContent;
    press("edit");
    article.querySelector("p")!.append(" more");
    article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "e" }));
    press("done");
    await vi.waitFor(() => expect(states(told)[0]?.status).toBe("Not saved: the edit holds a script"));
    expect(article.getAttribute("contenteditable")).toBe("true");
    press("discard");
    expect(article.hasAttribute("contenteditable")).toBe(false);
    expect(article.querySelector("p")!.textContent).toBe(before);
    expect(states(told)[0]).toMatchObject({ editing: false, pending: false });
    told.mockRestore();
  });

  it("refuses to send an edit longer than the server takes, and keeps it waiting", async () => {
    const save = vi.fn().mockResolvedValue({});
    (window as { kos?: unknown }).kos = { save };
    const told = vi.spyOn(window, "postMessage");
    const article = mount(ARTICLE);
    startDoc();
    press("edit");
    article.querySelector("p")!.append("x".repeat(DOC_EDIT_MAX));
    article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "x" }));
    press("done");
    await vi.waitFor(() => expect(states(told)[0]?.status).toMatch(/an edit saves at most 300000/));
    expect(save).not.toHaveBeenCalled();
    expect(article.getAttribute("contenteditable")).toBe("true");
    told.mockRestore();
  });

  it("ticks no to-do for a click a script made, only for the owner's own (the Chrome test presses one)", async () => {
    const save = vi.fn().mockResolvedValue({ version: 2 });
    (window as { kos?: unknown }).kos = { save };
    const article = mount(`<ul class="checklist"><li data-checked="false">Milk</li><li data-checked="true">Eggs</li></ul>`);
    startDoc();
    const boxes = [...article.querySelectorAll<HTMLButtonElement>(".todo-box")];
    expect(boxes.map((b) => [b.getAttribute("role"), b.getAttribute("aria-checked")])).toEqual([["checkbox", "false"], ["checkbox", "true"]]);
    boxes[0]!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(save).not.toHaveBeenCalled();
    expect(article.querySelector("li")!.getAttribute("data-checked")).toBe("false");
  });

  /** A to-do's box pressed by the owner, as the browser would report it. */
  const tick = (box: Element): void => {
    const trusted = vi.spyOn(clicks, "trusted").mockReturnValue(true);
    (box as HTMLElement).click();
    trusted.mockRestore();
  };
  const list = `<ul class="checklist"><li data-checked="false">A</li><li data-checked="false">B</li></ul>`;

  it("keeps two ticks made in one gap when Edit is pressed before the second is saved", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ version: 2 });
    (window as { kos?: unknown }).kos = { save };
    document.execCommand = vi.fn() as typeof document.execCommand;
    const article = mount(list);
    startDoc();
    const [a, b] = [...article.querySelectorAll(".todo-box")];
    tick(a!);
    await vi.advanceTimersByTimeAsync(100);
    tick(b!);
    press("edit");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_GAP_MS + 100);
    expect(article.getAttribute("contenteditable")).toBe("true");
    press("done");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_GAP_MS * 2);
    vi.useRealTimers();
    expect(save.mock.calls.at(-1)![0]).toEqual({ doc: list.replace(/"false"/g, '"true"') });
  });

  it("carries a tick whose save was refused into the next", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue({ version: 2 });
    (window as { kos?: unknown }).kos = { save };
    const article = mount(list);
    startDoc();
    const [a, b] = [...article.querySelectorAll(".todo-box")];
    tick(a!);
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    tick(b!);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_GAP_MS + 100);
    vi.useRealTimers();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toEqual({ doc: list.replace(/"false"/g, '"true"') });
  });

  it("keeps saves in one line, each the gap after the last", async () => {
    vi.useFakeTimers();
    const queue = saveQueue();
    const at: number[] = [];
    const run = (): Promise<boolean> => queue.run(async () => (at.push(Date.now()), true));
    void run();
    void run();
    const last = run();
    await vi.runAllTimersAsync();
    await last;
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(AUTOSAVE_GAP_MS);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(AUTOSAVE_GAP_MS);
    vi.useRealTimers();
  });

  it("gives a locked doc's to-dos boxes that cannot be ticked", () => {
    (window as { kos?: unknown }).kos = { save: vi.fn() };
    const article = mount(`<ul class="checklist"><li data-checked="false">Milk</li></ul>`, "data-locked");
    startDoc();
    expect(article.querySelector(".todo-box")!.hasAttribute("disabled")).toBe(true);
  });

  it("opens a mentioned artifact through kos.open when pressed, but not while editing nor for a bad id", () => {
    const open = vi.fn().mockResolvedValue({ opened: true });
    (window as { kos?: unknown }).kos = { save: vi.fn(), open };
    document.execCommand = vi.fn() as typeof document.execCommand;
    const article = mount(`<p>See <span class="mention" data-artifact="q4-plan">Q4 Plan</span> <span class="mention" data-artifact="../x">X</span></p>`);
    startDoc();
    const [chip, bad] = [...article.querySelectorAll<HTMLElement>(".mention")];
    expect([chip!.getAttribute("role"), chip!.getAttribute("tabindex")]).toEqual(["link", "0"]);
    chip!.click();
    bad!.click();
    expect(open.mock.calls).toEqual([["q4-plan"]]);
    press("edit");
    chip!.click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("says quietly in the head when an open was refused", async () => {
    const told = vi.spyOn(window, "postMessage");
    (window as { kos?: unknown }).kos = { save: vi.fn(), open: vi.fn().mockRejectedValue(new Error("there is no artifact by that id")) };
    const article = mount(`<p><span class="mention" data-artifact="gone">Gone</span></p>`);
    startDoc();
    article.querySelector<HTMLElement>(".mention")!.click();
    await vi.waitFor(() => expect(states(told).some((s) => s.status === "Not opened: there is no artifact by that id")).toBe(true));
    told.mockRestore();
  });

  it("undoes a block's move from the dashboard's Undo, and redoes it", () => {
    (window as { kos?: unknown }).kos = { save: vi.fn() };
    document.execCommand = vi.fn() as typeof document.execCommand;
    const article = mount(`<p>One</p><p>Two</p>`);
    startDoc();
    press("edit");
    const two = article.children[1]!;
    getSelection()!.collapse(two.firstChild, 1);
    article.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(article.textContent).toBe("TwoOne");
    press("undo");
    expect(article.textContent).toBe("OneTwo");
    press("redo");
    expect(article.textContent).toBe("TwoOne");
  });

  it("takes a drop as plain text, as a paste is", () => {
    (window as { kos?: unknown }).kos = { save: vi.fn() };
    const run = vi.fn();
    document.execCommand = run as typeof document.execCommand;
    const article = mount(ARTICLE);
    startDoc();
    press("edit");
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, "dataTransfer", { value: { getData: (t: string) => (t === "text/plain" ? "dropped words" : '<img src="https://x.example/p.png">') } });
    article.querySelector("p")!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledWith("insertText", false, "dropped words");
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    article.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
  });

  it("keeps an image well inside what an edit may hold, counting base64's growth", () => {
    expect((IMAGE_MAX * 4) / 3).toBeLessThan(DOC_EDIT_MAX);
  });
});

describe("what the doc editor reads as markdown", () => {
  it("turns a line's start into a block, and nothing else", () => {
    expect(shortcutOf("#")).toBe("h1");
    expect(shortcutOf("###")).toBe("h3");
    expect(shortcutOf("-")).toBe("ul");
    expect(shortcutOf("1.")).toBe("ol");
    expect(shortcutOf(">")).toBe("quote");
    expect(shortcutOf("[]")).toBe("todo");
    expect(shortcutOf("```")).toBe("code");
    expect(shortcutOf("---")).toBe("divider");
    expect(shortcutOf(">>")).toBe("toggle");
    expect(shortcutOf("####")).toBeUndefined();
    expect(shortcutOf("a")).toBeUndefined();
  });

  it("closes bold and code around words just typed", () => {
    expect(inlineMark("it is **very**")).toEqual({ tag: "strong", words: "very", length: 8 });
    expect(inlineMark("run `kos`")).toEqual({ tag: "code", words: "kos", length: 5 });
    expect(inlineMark("not ~~this~~")).toEqual({ tag: "s", words: "this", length: 8 });
    expect(inlineMark("an *aside*")).toEqual({ tag: "em", words: "aside", length: 7 });
    expect(inlineMark("a * b")).toBeUndefined();
    expect(inlineMark("****")).toBeUndefined();
  });

  it("finds a block in the slash menu by the start of its words", () => {
    expect(slashMatches("").length).toBeGreaterThan(8);
    expect(slashMatches("head 2").map((i) => i.id)).toEqual(["h2"]);
    expect(slashMatches("list").map((i) => i.id)).toEqual(["ul", "ol", "todo"]);
    expect(slashMatches("tog").map((i) => i.id)).toEqual(["toggle"]);
    expect(slashMatches("to").map((i) => i.id)).toEqual(["todo", "toggle"]);
    expect(slashMatches("img")).toEqual([]);
    expect(slashMatches("image").map((i) => i.id)).toEqual(["image"]);
  });
});
