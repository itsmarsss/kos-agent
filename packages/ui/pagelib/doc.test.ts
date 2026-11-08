// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOC_MIN, cleanDocHtml, enhance, slugOf, startDoc } from "./doc.js";
import { DOC_EDIT_MAX } from "@kos/shared/artifacts";

import { AUTOSAVE_GAP_MS, AUTOSAVE_MS, IMAGE_MAX, inlineMark, shortcutOf, slashMatches } from "./docedit.js";

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
  /** The dashboard's edit bar, pressed. */
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
    expect(article.querySelector(".fn-ref")).toBeNull();
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
    await vi.waitFor(() => expect(article.hasAttribute("contenteditable")).toBe(false));
    expect(states(told)[0]).toMatchObject({ editing: false, pending: false });
    expect(states(told).some((s) => s.status === "Saved")).toBe(true);
    expect(article.querySelectorAll(".fn-ref")).toHaveLength(2);
    told.mockRestore();
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
    expect(shortcutOf("[]")).toBe("check");
    expect(shortcutOf("####")).toBeUndefined();
    expect(shortcutOf("a")).toBeUndefined();
  });

  it("closes bold and code around words just typed", () => {
    expect(inlineMark("it is **very**")).toEqual({ tag: "strong", words: "very", length: 8 });
    expect(inlineMark("run `kos`")).toEqual({ tag: "code", words: "kos", length: 5 });
    expect(inlineMark("a * b")).toBeUndefined();
    expect(inlineMark("****")).toBeUndefined();
  });

  it("finds a block in the slash menu by the start of its words", () => {
    expect(slashMatches("").length).toBeGreaterThan(8);
    expect(slashMatches("head 2").map((i) => i.id)).toEqual(["h2"]);
    expect(slashMatches("list").map((i) => i.id)).toEqual(["ul", "ol"]);
    expect(slashMatches("img")).toEqual([]);
    expect(slashMatches("image").map((i) => i.id)).toEqual(["image"]);
  });
});
