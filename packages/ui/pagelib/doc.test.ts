// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOC_MIN, cleanDocHtml, enhance, slugOf, startDoc } from "./doc.js";
import { AUTOSAVE_GAP_MS, AUTOSAVE_MS, inlineMark, shortcutOf, slashMatches } from "./docedit.js";

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

  it("shows no Edit control without kos.save, or when locked", () => {
    mount(ARTICLE);
    startDoc();
    expect(document.querySelector(".doc-tools")).toBeNull();
    (window as { kos?: unknown }).kos = { save: vi.fn() };
    mount(ARTICLE, "data-locked");
    startDoc();
    expect(document.querySelector(".doc-tools")).toBeNull();
  });

  it("saves an edit as the article's clean HTML when the owner is done, then draws the doc again", async () => {
    const save = vi.fn().mockResolvedValue({ version: 2 });
    (window as { kos?: unknown }).kos = { save };
    document.execCommand = vi.fn() as typeof document.execCommand;
    const article = mount(ARTICLE);
    startDoc();
    const button = (label: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>(".doc-tools button")].find((b) => b.textContent === label)!;

    button("Edit").click();
    expect(article.getAttribute("contenteditable")).toBe("true");
    expect(article.querySelector(".fn-ref")).toBeNull();
    // Done with nothing changed saves nothing.
    button("Done").click();
    await vi.waitFor(() => expect(article.hasAttribute("contenteditable")).toBe(false));
    expect(save).not.toHaveBeenCalled();

    button("Edit").click();
    article.querySelector("h1")!.textContent = "Garden plan, revised";
    article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "d" }));
    button("Done").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![0] as { doc: string };
    expect(sent.doc).toContain("<h1>Garden plan, revised</h1>");
    expect(sent.doc).toContain('<span class="fn">Each 1.2 m by 3 m.</span>');
    expect(sent.doc).not.toContain("data-kos-gen");
    await vi.waitFor(() => expect(article.hasAttribute("contenteditable")).toBe(false));
    expect(document.querySelector(".doc-tools .doc-status")!.textContent).toBe("Saved");
    expect(article.querySelectorAll(".fn-ref")).toHaveLength(2);
  });

  it("saves on its own a moment after the owner stops typing, one save for a run of keys", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn().mockResolvedValue({ version: 2 });
      (window as { kos?: unknown }).kos = { save };
      const article = mount(ARTICLE);
      startDoc();
      [...document.querySelectorAll<HTMLButtonElement>(".doc-tools button")].find((b) => b.textContent === "Edit")!.click();
      for (const word of [" one", " two", " three"]) {
        article.querySelector("p")!.append(word);
        article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "e" }));
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(save).toHaveBeenCalledTimes(1);
      expect((save.mock.calls[0]![0] as { doc: string }).doc).toContain("one two three");
      // The next is held to the gap between saves, as the server takes one edit every 2 s.
      article.querySelector("p")!.append(" four");
      article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "r" }));
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(AUTOSAVE_GAP_MS);
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why a save was refused and stays in editing", async () => {
    (window as { kos?: unknown }).kos = { save: vi.fn().mockRejectedValue(new Error("the edit holds a script")) };
    const article = mount(ARTICLE);
    startDoc();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".doc-tools button")];
    buttons.find((b) => b.textContent === "Edit")!.click();
    article.querySelector("p")!.append(" more");
    article.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "e" }));
    buttons.find((b) => b.textContent === "Done")!.click();
    await vi.waitFor(() => expect(document.querySelector(".doc-tools .doc-status")!.textContent).toBe("Not saved: the edit holds a script"));
    expect(article.getAttribute("contenteditable")).toBe("true");
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
