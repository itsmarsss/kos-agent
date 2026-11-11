import { describe, expect, it } from "vitest";

import { docMarkdown } from "./docmarkdown.js";

const doc = (inner: string): string => `<style>h1{color:red}</style><article data-doc>${inner}</article><script>ignored()</script>`;

describe("a doc as Markdown", () => {
  it("writes the header, sections and the doc's notes", () => {
    const md = docMarkdown(
      doc(
        `<header><p class="kicker">Brief</p><h1>Garden water plan</h1><p class="lede">Four tanks cover a <em>third</em> of summer.</p><p class="byline">Westside garden, November</p></header>` +
          `<h2>Why</h2><p>The tap cannot serve 42 plots<span class="fn">Plot count, <strong>October</strong> 2026.</span>, so <b>tanks</b> go by the sheds<span class="fn">See the map.</span>.</p>`,
      ),
    );
    expect(md).toBe(
      [
        "Brief",
        "# Garden water plan",
        "Four tanks cover a *third* of summer.",
        "*Westside garden, November*",
        "## Why",
        "The tap cannot serve 42 plots[^1], so **tanks** go by the sheds[^2].",
        "[^1]: Plot count, **October** 2026.\n[^2]: See the map.",
      ].join("\n\n") + "\n",
    );
  });

  it("keeps lists nested and tight, checklists ticked, and an ordered list's start", () => {
    const md = docMarkdown(doc(`<ul><li>Tanks<ul><li>four</li><li>by the sheds</li></ul></li><li>Pipes</li></ul><ol start="3"><li>Order</li><li>Fit</li></ol><ul class="checklist"><li data-checked="true">Quote</li><li data-checked="false">Permit</li></ul>`));
    expect(md).toBe("- Tanks\n  - four\n  - by the sheds\n- Pipes\n\n3. Order\n4. Fit\n\n- [x] Quote\n- [ ] Permit\n");
  });

  it("writes a table as GitHub's, with its caption, pipes escaped and a span padded", () => {
    const md = docMarkdown(doc(`<table><caption>Costs</caption><thead><tr><th>Item</th><th class="num">Cost</th></tr></thead><tbody><tr><td>Tanks | pumps</td><td>$4,800</td></tr><tr><td colspan="2">Total to come<br>in spring</td></tr></tbody></table>`));
    expect(md).toBe("*Costs*\n\n| Item | Cost |\n| --- | --- |\n| Tanks \\| pumps | $4,800 |\n| Total to come<br>in spring |  |\n");
  });

  it("numbers figures as the doc does, keeps an image, and drops a drawing but not its caption", () => {
    const md = docMarkdown(
      doc(`<figure><img src="data:image/png;base64,AAAA" alt="The plot map"><figcaption>Where the tanks go</figcaption></figure><figure><svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg><figcaption>Rain by month</figcaption></figure><figure class="unnumbered"><p>Plain</p><figcaption>No number</figcaption></figure>`),
    );
    expect(md).toBe("![The plot map](data:image/png;base64,AAAA)\n\n*Figure 1. Where the tanks go*\n\n*Figure 2. Rain by month*\n\nPlain\n\n*No number*\n");
  });

  it("quotes a pull quote and a callout, fences code with its language, and links to headings", () => {
    const md = docMarkdown(
      doc(`<blockquote class="pull"><p>Water is the plan.</p><p>All of it.</p></blockquote><aside class="callout"><p>Note the <a href="#cost">cost</a>.</p></aside><pre><code class="language-sql">SELECT *\nFROM tanks</code></pre><p>Run <code>a \`b\` c</code> first.</p><hr>`),
    );
    expect(md).toBe("> Water is the plan.\n>\n> All of it.\n\n> Note the [cost](#cost).\n\n```sql\nSELECT *\nFROM tanks\n```\n\nRun ``a `b` c`` first.\n\n---\n");
  });

  it("escapes what Markdown would read as its own, and leaves snake_case alone", () => {
    const md = docMarkdown(doc(`<p>1. Not a list, *not* emphasis, [not] a link, <span>a_b</span> and _this_.</p><p># not a heading</p>`));
    expect(md).toBe("1\\. Not a list, \\*not\\* emphasis, \\[not\\] a link, a_b and \\_this\\_.\n\n\\# not a heading\n");
  });

  it("reads the body when there is no article, and leaves out scripts and styles", () => {
    expect(docMarkdown("<style>p{}</style><h1>Plain</h1><p>Text</p><script>x()</script>")).toBe("# Plain\n\nText\n");
  });
});
