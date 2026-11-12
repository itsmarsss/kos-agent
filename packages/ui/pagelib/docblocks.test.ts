// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanDocHtml, enhance } from "./doc.js";
import {
  allBlocks, blockOf, duplicate, ensureTodoBoxes, indent, kindOf, mergeBack, moveBlock, moveBlocks, moveTo, normalise, outdent, removeBlocks, splitBlock, tableEdit, toggleTodo, turnInto,
} from "./docblocks.js";
import { History } from "./dochistory.js";
import { IMAGE_MAX, PASTE_IMAGE_MAX, cleanPaste, isInline, parseClipboard } from "./docpaste.js";
import { toggleMark } from "./docedit.js";
import { Menu } from "./docui.js";

function mount(inner: string): HTMLElement {
  document.body.innerHTML = `<article data-doc>${inner}</article>`;
  return document.querySelector("article")!;
}
/** The article's markup with the whitespace between tags gone, to read. */
const html = (a: Element): string => a.innerHTML.replace(/>\s+</g, "><").trim();
const $ = <T extends HTMLElement = HTMLElement>(a: Element, s: string): T => a.querySelector<T>(s)!;
const textAt = (el: Element, offset: number): { node: Node; offset: number } => ({ node: el.firstChild!, offset });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("what a block is", () => {
  it("reads list items, the header's lines and a callout as one block each, in order", () => {
    const a = mount(`<header><p class="kicker">K</p><h1>T</h1></header><h2>A</h2><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><aside class="callout"><p>x</p><p>y</p></aside><p>end</p>`);
    expect(allBlocks(a).map((b) => b.textContent)).toEqual(["K", "T", "A", "onenested", "nested", "two", "xy", "end"]);
    expect(blockOf(a, $(a, "aside p").firstChild)).toBe($(a, "aside"));
    expect(blockOf(a, $(a, "li li").firstChild)?.textContent).toBe("nested");
  });
});

describe("turning a block into another kind", () => {
  it("makes a paragraph a heading, a quote, a callout, a toggle and code, keeping its words and id", () => {
    const a = mount(`<p id="keep">Some <strong>bold</strong> words</p>`);
    turnInto(a, $(a, "p"), "h2");
    expect(html(a)).toBe(`<h2 id="keep">Some <strong>bold</strong> words</h2>`);
    turnInto(a, $(a, "h2"), "callout");
    expect(html(a)).toBe(`<aside class="callout" id="keep"><p>Some <strong>bold</strong> words</p></aside>`);
    turnInto(a, $(a, "aside"), "toggle");
    expect(html(a)).toBe(`<details open="" id="keep"><summary>Some <strong>bold</strong> words</summary><p><br></p></details>`);
    turnInto(a, $(a, "details"), "code");
    expect(html(a)).toBe(`<pre id="keep"><code>Some bold words</code></pre>`);
    turnInto(a, $(a, "pre"), "p");
    expect(html(a)).toBe(`<p id="keep">Some bold words</p>`);
  });

  it("joins a list beside it of the same kind, and splits one when an item leaves", () => {
    const a = mount(`<ul><li>a</li></ul><p>b</p><ul><li>c</li></ul>`);
    turnInto(a, $(a, "p"), "ul");
    expect(html(a)).toBe(`<ul><li>a</li><li>b</li><li>c</li></ul>`);
    turnInto(a, a.querySelectorAll("li")[1] as HTMLElement, "p");
    expect(html(a)).toBe(`<ul><li>a</li></ul><p>b</p><ul><li>c</li></ul>`);
  });

  it("turns a list item into a to-do in a checklist of its own, and back", () => {
    const a = mount(`<ul><li>a</li><li>b</li><li>c</li></ul>`);
    turnInto(a, a.querySelectorAll("li")[1] as HTMLElement, "todo");
    expect(html(a)).toBe(`<ul><li>a</li></ul><ul class="checklist"><li data-checked="false">b</li></ul><ul><li>c</li></ul>`);
    turnInto(a, $(a, ".checklist li"), "ul");
    expect(html(a)).toBe(`<ul><li>a</li><li>b</li><li>c</li></ul>`);
    expect(kindOf($(a, "li"))).toBe("ul");
  });

  it("takes a quote of several paragraphs apart rather than losing any", () => {
    const a = mount(`<blockquote><p>one</p><p>two</p></blockquote>`);
    turnInto(a, $(a, "blockquote"), "p");
    expect(html(a)).toBe(`<p>one</p><p>two</p>`);
  });
});

describe("moving blocks", () => {
  it("moves a block up and down among its peers, and stops at the ends", () => {
    const a = mount(`<p>1</p><p>2</p><p>3</p>`);
    expect(moveBlock(a, a.children[2] as HTMLElement, -1)).toBe(true);
    expect(a.textContent).toBe("132");
    expect(moveBlock(a, a.children[0] as HTMLElement, -1)).toBe(false);
    expect(moveBlock(a, a.children[0] as HTMLElement, 1)).toBe(true);
    expect(a.textContent).toBe("312");
  });

  it("steps a paragraph through a list item by item, splitting the list and joining it again", () => {
    const a = mount(`<ul><li>a</li><li>b</li></ul><p>p</p>`);
    moveBlock(a, $(a, "p"), -1);
    expect(html(a)).toBe(`<ul><li>a</li></ul><p>p</p><ul><li>b</li></ul>`);
    moveBlock(a, $(a, "p"), 1);
    expect(html(a)).toBe(`<ul><li>a</li><li>b</li></ul><p>p</p>`);
  });

  it("drops a list item among other blocks as a list of its own", () => {
    const a = mount(`<h2>H</h2><ol><li>a</li><li>b</li></ol>`);
    moveTo(a, a.querySelectorAll("li")[1] as HTMLElement, $(a, "h2"), "before");
    expect(html(a)).toBe(`<ol><li>b</li></ol><h2>H</h2><ol><li>a</li></ol>`);
  });

  it("moves a run of picked blocks together", () => {
    const a = mount(`<p>1</p><p>2</p><p>3</p><p>4</p>`);
    const run = [a.children[1], a.children[2]] as HTMLElement[];
    expect(moveBlocks(a, run, 1)).toBe(true);
    expect(a.textContent).toBe("1423");
    expect(moveBlocks(a, run, -1)).toBe(true);
    expect(moveBlocks(a, run, -1)).toBe(true);
    expect(a.textContent).toBe("2314");
    expect(moveBlocks(a, run, -1)).toBe(false);
  });
});

describe("duplicating and deleting", () => {
  it("copies a block after itself without its ids", () => {
    const a = mount(`<h2 id="x">Title <span id="y">here</span></h2>`);
    duplicate($(a, "h2"));
    expect(html(a)).toBe(`<h2 id="x">Title <span id="y">here</span></h2><h2>Title <span>here</span></h2>`);
  });

  it("takes blocks out, a list left empty with them, and leaves a line when nothing is left", () => {
    const a = mount(`<p>1</p><ul><li>a</li></ul><p>2</p>`);
    const next = removeBlocks(a, [$(a, "li")]);
    expect(html(a)).toBe(`<p>1</p><p>2</p>`);
    expect(next.textContent).toBe("2");
    removeBlocks(a, [...a.children] as HTMLElement[]);
    expect(html(a)).toBe(`<p><br></p>`);
  });
});

describe("Enter and Backspace", () => {
  it("splits a paragraph at the caret, its marks on both sides", () => {
    const a = mount(`<p>one <strong>bold</strong> two</p>`);
    const at = splitBlock(a, $(a, "p"), { node: $(a, "strong").firstChild!, offset: 2 });
    expect(html(a)).toBe(`<p>one <strong>bo</strong></p><p><strong>ld</strong> two</p>`);
    expect(at?.node).toBe(a.children[1]);
  });

  it("gives a heading's end a paragraph, and a to-do a new unticked one", () => {
    const a = mount(`<h2>Head</h2><ul class="checklist"><li data-checked="true">done</li></ul>`);
    splitBlock(a, $(a, "h2"), textAt($(a, "h2"), 4));
    expect(html(a)).toBe(`<h2>Head</h2><p><br></p><ul class="checklist"><li data-checked="true">done</li></ul>`);
    splitBlock(a, $(a, "li"), textAt($(a, "li"), 4));
    expect(html(a)).toContain(`<li data-checked="true">done</li><li data-checked="false"><br></li>`);
  });

  it("takes an empty item out of its list, or out a level when nested", () => {
    const a = mount(`<ul><li>a<ul><li>b</li><li><br></li></ul></li></ul>`);
    const empty = a.querySelectorAll("li")[2] as HTMLElement;
    splitBlock(a, empty, { node: empty, offset: 0 });
    expect(html(a)).toBe(`<ul><li>a<ul><li>b</li></ul></li><li><br></li></ul>`);
    const again = a.querySelectorAll("li")[2] as HTMLElement;
    splitBlock(a, again, { node: again, offset: 0 });
    expect(html(a)).toBe(`<ul><li>a<ul><li>b</li></ul></li></ul><p><br></p>`);
  });

  it("steps out of a callout from its empty last line", () => {
    const a = mount(`<aside class="callout"><p>note</p><p><br></p></aside>`);
    const last = a.querySelectorAll("aside p")[1] as HTMLElement;
    splitBlock(a, $(a, "aside"), { node: last, offset: 0 });
    expect(html(a)).toBe(`<aside class="callout"><p>note</p></aside><p><br></p>`);
  });

  it("joins a paragraph onto the one before at its start, and a heading first becomes text", () => {
    const a = mount(`<p>one <em>two</em></p><h3>three</h3>`);
    const first = mergeBack(a, $(a, "h3"), textAt($(a, "h3"), 0));
    expect(html(a)).toBe(`<p>one <em>two</em></p><p>three</p>`);
    expect(first).toBeTruthy();
    const second = a.children[1] as HTMLElement;
    const at = mergeBack(a, second, textAt(second, 0));
    expect(html(a)).toBe(`<p>one <em>two</em>three</p>`);
    expect(at).toEqual({ node: a.children[0], offset: 2 });
  });

  it("takes a divider away, and asks for a figure before to be picked rather than joined", () => {
    const a = mount(`<p>a</p><hr><p>b</p><figure><figcaption>f</figcaption></figure><p>c</p>`);
    mergeBack(a, a.children[2] as HTMLElement, textAt(a.children[2]!, 0));
    expect(html(a)).toBe(`<p>a</p><p>b</p><figure><figcaption>f</figcaption></figure><p>c</p>`);
    expect(mergeBack(a, a.children[3] as HTMLElement, textAt(a.children[3]!, 0))).toBe("select");
  });
});

describe("indenting list items", () => {
  it("nests an item under the one before, and brings it out with the items after it under it", () => {
    const a = mount(`<ul><li>a</li><li>b</li><li>c</li></ul>`);
    const [, b, c] = [...a.querySelectorAll("li")] as HTMLElement[];
    expect(indent(b!)).toBe(true);
    expect(indent(c!)).toBe(true);
    expect(html(a)).toBe(`<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>`);
    expect(outdent(b!)).toBe(true);
    expect(html(a)).toBe(`<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>`);
    expect(outdent(b!)).toBe(false);
    expect(indent($(a, "li"))).toBe(false);
  });
});

describe("to-dos", () => {
  it("ticks and unticks, its box the runtime's alone", () => {
    const a = mount(`<ul class="checklist"><li data-checked="false">milk</li></ul>`);
    ensureTodoBoxes(a);
    const box = $(a, ".todo-box");
    expect(box.getAttribute("role")).toBe("checkbox");
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(toggleTodo($(a, "li"))).toBe(true);
    ensureTodoBoxes(a);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(a.querySelectorAll(".todo-box")).toHaveLength(1);
    // The box is named by the item's words, through an id the save takes off again.
    expect(box.getAttribute("aria-labelledby")).toBe($(a, "li").id);
    expect(box.hasAttribute("aria-label")).toBe(false);
    expect(cleanDocHtml(a)).toBe(`<ul class="checklist"><li data-checked="true">milk</li></ul>`);
  });

  it("names an item's box by its own words, not by the items nested under it", () => {
    const a = mount(`<ul class="checklist"><li data-checked="false">Pack <em>bags</em><ul class="checklist"><li data-checked="false">socks</li></ul></li></ul>`);
    ensureTodoBoxes(a);
    const [outer, inner] = [...a.querySelectorAll(".todo-box")];
    expect(outer!.getAttribute("aria-label")).toBe("Pack bags");
    expect(outer!.hasAttribute("aria-labelledby")).toBe(false);
    expect(document.getElementById(inner!.getAttribute("aria-labelledby")!)!.textContent).toBe("socks");
    expect(cleanDocHtml(a)).not.toMatch(/id=|aria/);
  });
});

describe("tables", () => {
  it("adds and removes rows and columns beside a cell, keeping one of each", () => {
    const a = mount(`<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`);
    tableEdit($(a, "td"), "row-after");
    tableEdit($<HTMLTableCellElement>(a, "td"), "col-after");
    expect(html(a)).toBe(`<table><thead><tr><th>A</th><th><br></th><th>B</th></tr></thead><tbody><tr><td>1</td><td><br></td><td>2</td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table>`);
    tableEdit($<HTMLTableCellElement>(a, "td"), "row-remove");
    tableEdit(a.querySelectorAll<HTMLTableCellElement>("td")[1]!, "col-remove");
    expect(html(a)).toBe(`<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><br></td><td><br></td></tr></tbody></table>`);
    expect(tableEdit($<HTMLTableCellElement>(a, "td"), "row-remove")).toBeUndefined();
  });
});

describe("marks", () => {
  it("wraps words in a highlight and takes it off again", () => {
    const a = mount(`<p>one two three</p>`);
    const r = document.createRange();
    r.setStart($(a, "p").firstChild!, 4);
    r.setEnd($(a, "p").firstChild!, 7);
    toggleMark(r, "mark", "hl-ok");
    expect(html(a)).toBe(`<p>one <mark class="hl-ok">two</mark> three</p>`);
    const again = document.createRange();
    again.selectNodeContents($(a, "mark"));
    toggleMark(again, "mark", "hl-ok");
    expect(a.textContent).toBe("one two three");
    expect(a.querySelector("mark")).toBeNull();
  });

  it("makes what the browser's commands leave the doc's own", () => {
    const a = mount(`<p><strike>gone</strike> <font color="red">red</font></p><ul class="checklist"><li>x</li></ul><ol><li data-checked="true">y</li></ol>`);
    normalise(a);
    expect(html(a)).toBe(`<p><s>gone</s> red</p><ul class="checklist"><li data-checked="false">x</li></ul><ol><li>y</li></ol>`);
  });
});

describe("a paste", () => {
  const paste = (markup: string): string => {
    const frag = cleanPaste(parseClipboard(markup)!.body, document);
    const box = document.createElement("div");
    box.append(frag);
    return box.innerHTML;
  };

  it("keeps the structure and marks of rich text, and nothing of its styles, ids or links off the page", () => {
    const got = paste(`<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1"><h1 class="t" style="color:red">Title</h1><p dir="ltr"><span style="font-weight:700">Bold</span> and <span style="font-style:italic">it</span> <a href="https://evil.example/">link</a> <a href="#sec">here</a></p><ul><li><p>one</p></li></ul></b>`);
    expect(got).toBe(`<h1>Title</h1><p><strong>Bold</strong> and <em>it</em> link <a href="#sec">here</a></p><ul><li>one</li></ul>`);
  });

  it("drops scripts, styles, frames, handlers and images from the network, and keeps one held as data", () => {
    const got = paste(`<p onclick="x()">a<script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe><img src="https://x.example/p.png" onerror="x()"><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"></p>`);
    expect(got).toBe(`<p>a<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"></p>`);
  });

  it("reads checkboxes as to-dos, code with its language, and tables", () => {
    const got = paste(`<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> not</li></ul><pre><code class="language-ts hl">const x = 1;</code></pre><table style="x"><tr><td colspan="2" class="c">a</td></tr></table><h5>small</h5>`);
    expect(got).toBe(`<ul class="checklist"><li data-checked="true"> done</li><li data-checked="false"> not</li></ul><pre><code class="language-ts">const x = 1;</code></pre><table><tbody><tr><td colspan="2">a</td></tr></tbody></table><h3>small</h3>`);
  });

  it("holds a picture pasted as data to the size a picked file may be", () => {
    const big = `data:image/png;base64,${"A".repeat(PASTE_IMAGE_MAX)}`;
    expect(paste(`<p>a<img src="${big}"></p>`)).toBe("<p>a</p>");
    expect(PASTE_IMAGE_MAX).toBeGreaterThan((IMAGE_MAX * 4) / 3);
    expect(PASTE_IMAGE_MAX).toBeLessThan((IMAGE_MAX * 4) / 3 + 100);
  });

  it("keeps a list with a box in only some items a list", () => {
    expect(paste(`<ul><li>a</li><li><input type="checkbox" checked>b</li></ul>`)).toBe(`<ul><li>a</li><li>b</li></ul>`);
  });

  it("keeps the doc's own marks when copied within a doc, and only valid ones", () => {
    const got = paste(
      `<aside class="callout warn x" style="color:red"><p>Risk</p></aside><p><mark class="hl-ok">green</mark> <mark class="hl-evil">plain</mark> <span class="tc-danger" style="font-weight:700">red</span> <span class="tc-nope">no</span> ` +
        `<span class="mention" data-artifact="q4-plan" contenteditable="false">Q4 Plan</span> <span class="mention" data-artifact="../x">Bad</span></p>` +
        `<table><tr><td colspan="0" rowspan="999">a</td><td colspan="-3">b</td></tr></table>`,
    );
    expect(got).toBe(
      `<aside class="callout warn"><p>Risk</p></aside><p><mark class="hl-ok">green</mark> <mark>plain</mark> <span class="tc-danger"><strong>red</strong></span> no ` +
        `<span class="mention" data-artifact="q4-plan">Q4 Plan</span> Bad</p>` +
        `<table><tbody><tr><td colspan="1" rowspan="50">a</td><td colspan="1">b</td></tr></tbody></table>`,
    );
  });

  it("tells words from blocks", () => {
    expect(isInline(cleanPaste(parseClipboard("<span>just <b>words</b></span>")!.body, document))).toBe(true);
    expect(isInline(cleanPaste(parseClipboard("<p>a</p><p>b</p>")!.body, document))).toBe(false);
  });
});

describe("undo across block operations", () => {
  it("puts back each step in turn, typing and moves alike, and redoes them", () => {
    const a = mount(`<p>1</p><p>2</p>`);
    const h = new History(a);
    h.record();
    moveBlock(a, a.children[1] as HTMLElement, -1);
    h.typed("insert", 1000);
    a.children[0]!.textContent = "2a";
    h.typed("insert", 1100);
    a.children[0]!.textContent = "2ab";
    h.record();
    turnInto(a, a.children[1] as HTMLElement, "h2");
    expect(html(a)).toBe(`<p>2ab</p><h2>1</h2>`);
    expect(h.undo()).toBe(true);
    expect(html(a)).toBe(`<p>2ab</p><p>1</p>`);
    // The run of typing is one step.
    expect(h.undo()).toBe(true);
    expect(html(a)).toBe(`<p>2</p><p>1</p>`);
    expect(h.undo()).toBe(true);
    expect(html(a)).toBe(`<p>1</p><p>2</p>`);
    expect(h.undo()).toBe(false);
    h.redo();
    h.redo();
    h.redo();
    expect(html(a)).toBe(`<p>2ab</p><h2>1</h2>`);
  });
});

describe("the \"/\" menu, as a listbox", () => {
  it("tells the article it owns which list it controls and which option is picked, and forgets on close", () => {
    const a = mount("<p>x</p>");
    const menu = new Menu();
    menu.show([{ id: "p", label: "Text" }, { id: "h1", label: "Heading 1" }], { at: new DOMRect(0, 0, 0, 0), label: "Insert a block", listbox: true, owner: a, onPick: () => undefined });
    expect(a.getAttribute("aria-controls")).toBe(menu.root.id);
    expect(a.getAttribute("aria-activedescendant")).toBe(menu.root.querySelector('[role="option"]')!.id);
    menu.key(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(a.getAttribute("aria-activedescendant")).toBe(menu.root.querySelectorAll('[role="option"]')[1]!.id);
    expect(document.getElementById(a.getAttribute("aria-activedescendant")!)?.getAttribute("aria-selected")).toBe("true");
    menu.close();
    expect(["aria-controls", "aria-activedescendant", "aria-expanded"].map((n) => a.hasAttribute(n))).toEqual([false, false, false]);
    menu.remove();
  });
});

describe("the history's size", () => {
  it("lets go of the oldest steps past what it may hold, counting each step once", () => {
    const a = mount(`<p>${"x".repeat(100)}</p>`);
    const h = new History(a);
    const clone = vi.spyOn(Element.prototype, "outerHTML", "get");
    for (let i = 0; i < 5; i++) h.record();
    // One count a step as it is kept, never the whole history again.
    expect(clone.mock.calls.length).toBe(5);
    clone.mockRestore();
    let undone = 0;
    while (h.undo()) undone++;
    expect(undone).toBe(5);
  });
});

describe("a save, and the doc drawn again from it", () => {
  it("stores the new blocks as plain markup, with none of the editor's, and reads back the same", () => {
    const a = mount(`<h1>Plan</h1><p>first</p><p>second</p><p>third</p><p>code</p>`);
    enhance(a);
    const [, p1, p2, p3, p4] = [...a.children] as HTMLElement[];
    turnInto(a, p1!, "todo");
    turnInto(a, p2!, "toggle");
    turnInto(a, p3!, "callout").parentElement!.classList.add("warn");
    turnInto(a, p4!, "code").classList.add("language-python");
    ensureTodoBoxes(a);
    a.setAttribute("contenteditable", "true");
    a.querySelector("summary")!.setAttribute("data-kos-ph", "Toggle");
    $(a, "aside p").append("​");
    a.insertAdjacentHTML("beforeend", `<p>see <span class="mention" data-artifact="q4-plan" contenteditable="false">Q4 plan</span></p>`);
    const saved = cleanDocHtml(a);
    expect(saved).toBe(
      `<h1>Plan</h1><ul class="checklist"><li data-checked="false">first</li></ul><details open=""><summary>second</summary><p><br></p></details><aside class="callout warn"><p>third</p></aside><pre><code class="language-python">code</code></pre><p>see <span class="mention" data-artifact="q4-plan">Q4 plan</span></p>`,
    );
    expect(saved).not.toMatch(/data-kos|contenteditable|todo-box|​/);
    // Drawn again, as a reload does: the runtime's additions come back and go again on the next save.
    const again = mount(saved);
    enhance(again);
    expect(again.querySelector(".todo-box")).not.toBeNull();
    expect(again.querySelector(".mention")!.getAttribute("role")).toBe("link");
    expect(cleanDocHtml(again)).toBe(saved);
  });
});
