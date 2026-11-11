import { describe, expect, it } from "vitest";

import { applyPatch, patchEdits, patchSummary } from "./artifactpatch.js";

const DOC = `<style>h1{color:var(--text)}</style>
<main>
  <h1>Q3 review</h1>
  <section id="costs"><h2>Costs</h2><table><tr><td>Rent</td><td>1,800</td></tr></table></section>
  <p class="note">Draft</p>
  <p class="note">Draft</p>
  <script>const s = '<div id="costs">';</script>
</main>`;

describe("applyPatch", () => {
  it("replaces a find that occurs once, leaving the rest byte for byte", () => {
    const { html, replaced } = applyPatch(DOC, patchEdits([{ find: "<h1>Q3 review</h1>", replace: "<h1>Q4 review</h1>" }]));
    expect(html).toBe(DOC.replace("Q3", "Q4"));
    expect(replaced).toBe(1);
  });

  it("refuses a find that is missing, or that occurs more than once, saying how many", () => {
    expect(() => applyPatch(DOC, patchEdits([{ find: "<h1>Q2</h1>", replace: "x" }]))).toThrow(/edit 1: find does not occur/);
    expect(() => applyPatch(DOC, patchEdits([{ find: "Draft", replace: "Final" }]))).toThrow(/edit 1: find occurs 2 times.*all: true/);
  });

  it("replaces every occurrence with all, and takes a $ in the replacement as text", () => {
    const { html, replaced } = applyPatch(DOC, patchEdits([{ find: "Draft", replace: "$& $1 Final", all: true }]));
    expect(html.match(/\$& \$1 Final/g)).toHaveLength(2);
    expect(replaced).toBe(2);
  });

  it("applies edits in order, each to what the last left, and none when a later one fails", () => {
    const edits = patchEdits([
      { find: "Q3 review", replace: "Q4 review" },
      { find: "Q4 review", replace: "Q4 review, final" },
    ]);
    expect(applyPatch(DOC, edits).html).toContain("<h1>Q4 review, final</h1>");
    const failing = patchEdits([{ find: "Q3 review", replace: "Q4 review" }, { find: "nowhere", replace: "x" }]);
    expect(() => applyPatch(DOC, failing)).toThrow(/edit 2/);
  });

  it("replaces the one element with an id, whole, found as the browser parses it", () => {
    const { html } = applyPatch(DOC, patchEdits([{ id: "costs", html: '<section id="costs"><h2>Costs</h2><p>None</p></section>' }]));
    expect(html).toContain('<section id="costs"><h2>Costs</h2><p>None</p></section>\n  <p class="note">');
    // The id in the script's text is not an element, so it was neither counted nor touched.
    expect(html).toContain(`const s = '<div id="costs">';`);
  });

  it("refuses an id that is missing, repeated, or whose end is not written", () => {
    expect(() => applyPatch(DOC, patchEdits([{ id: "nope", html: "x" }]))).toThrow(/no element has id="nope"/);
    expect(() => applyPatch('<p id="a">1</p><p id="a">2</p>', patchEdits([{ id: "a", html: "x" }]))).toThrow(/2 elements have id="a"/);
    expect(() => applyPatch('<ul><li id="a">one<li>two</ul>', patchEdits([{ id: "a", html: "x" }]))).toThrow(/no end tag of its own/);
    expect(applyPatch('<p>a<br id="b">c</p>', patchEdits([{ id: "b", html: "<br>" }])).html).toBe("<p>a<br>c</p>");
  });

  it("matches a closing tag escaped as JSON writes it", () => {
    expect(applyPatch(DOC, patchEdits([{ find: "';<\\/script>", replace: "';</script><!-- end -->" }])).html).toContain("<!-- end -->");
  });

  it("refuses generated doc markup, which the runtime draws and never stores", () => {
    expect(() => applyPatch(DOC, patchEdits([{ find: "Draft", replace: '<nav data-kos-gen="toc">x</nav>', all: true }]))).toThrow(/data-kos-gen/);
    // Built across two edits, each harmless alone.
    const split = patchEdits([{ find: "<h1>Q3 review</h1>", replace: '<h1>Q3 review</h1><nav data-kos-XX="toc"></nav>' }, { find: "data-kos-XX", replace: "data-kos-gen" }]);
    expect(() => applyPatch(DOC, split)).toThrow(/the edits add data-kos-gen/);
    // One already there (an older write) is left as it was, and may be taken out.
    const marked = '<p data-kos-gen="x">a</p><p>b</p>';
    expect(applyPatch(marked, patchEdits([{ find: "<p>b</p>", replace: "<p>c</p>" }])).html).toBe('<p data-kos-gen="x">a</p><p>c</p>');
    expect(applyPatch(marked, patchEdits([{ find: ' data-kos-gen="x"', replace: "" }])).html).toBe("<p>a</p><p>b</p>");
  });

  it("refuses edits of the wrong shape", () => {
    expect(() => patchEdits([])).toThrow(/at least one/);
    expect(() => patchEdits([{ find: "", replace: "x" }])).toThrow(/find is empty/);
    expect(() => patchEdits([{ find: "a" }])).toThrow(/edit 1 is neither/);
    expect(() => patchEdits([{ find: "a", replace: "b", id: "c", html: "d" }])).toThrow(/edit 1 is neither/);
    expect(() => patchEdits(Array.from({ length: 51 }, () => ({ find: "a", replace: "b" })))).toThrow(/at most 50/);
  });
});

describe("patchSummary", () => {
  it("counts the lines between what stayed, and the bytes either side", () => {
    const after = DOC.replace("<h1>Q3 review</h1>", "<h1>Q4 review</h1>\n  <p>New</p>");
    expect(patchSummary(DOC, after)).toEqual({ lines: { removed: 1, added: 2, of: 9 }, bytes: { before: Buffer.byteLength(DOC), after: Buffer.byteLength(after) } });
  });
});
