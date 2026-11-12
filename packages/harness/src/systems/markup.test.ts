import { describe, expect, it } from "vitest";

import { unsavableDocText, withDocText } from "./artifactedit.js";
import { docEditOf, markupExits } from "./markup.js";

/** Every block the editor makes, as it stores them (ui/pagelib/docblocks.ts). */
const BLOCKS =
  '<ul class="checklist"><li data-checked="true">Book the room</li><li data-checked="false">Send the agenda<ul class="checklist"><li data-checked="false">Draft</li></ul></li></ul>' +
  '<details open=""><summary>Why we chose it</summary><p>Cost, then reach.</p></details><details><summary>Closed</summary><p>Hidden.</p></details>' +
  '<aside class="callout"><p>Note</p></aside><aside class="callout warn"><p>Risk</p></aside><aside class="callout ok"><p>Settled</p></aside><aside class="callout danger"><p>Stop</p></aside><aside class="callout note"><p>Aside</p></aside>' +
  '<pre><code class="language-python">print("hi")\n</code></pre><hr>' +
  '<p><s>gone</s> <u>under</u> <em>it</em> <mark>yellow</mark> <mark class="hl-ok">green</mark> <span class="tc-danger">red</span> <code>x</code> <a href="#why">why</a></p>' +
  '<p>See <span class="mention" data-artifact="q4-plan">Q4 Plan</span> for more.</p>' +
  '<ol><li>one<ol><li>nested</li></ol></li></ol><blockquote>Quote</blockquote>' +
  '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><br></td><td colspan="1">2</td></tr></tbody></table>' +
  '<figure><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"><figcaption>dot</figcaption></figure>';

describe("the editor's blocks, kept as a doc's text", () => {
  it("takes every block the editor makes, written back out unchanged", () => {
    expect(docEditOf(BLOCKS)).toBe(BLOCKS);
  });

  it("saves them in place of an article's text, and holds an agent's doc written with them savable", () => {
    const page = `<!doctype html><html><head><style>p{}</style></head><body><article data-doc><p>old</p></article><script>1</script></body></html>`;
    const saved = withDocText(page, BLOCKS);
    expect(saved).toBe(page.replace("<p>old</p>", BLOCKS));
    expect(unsavableDocText(saved)).toBeUndefined();
  });

  it("still refuses what a block could be made to carry: controls, handlers, code, and anything from outside", () => {
    const refused = [
      '<ul class="checklist"><li data-checked="true"><input type="checkbox" checked>x</li></ul>',
      '<ul class="checklist"><li><button class="todo-box" role="checkbox">x</button></li></ul>',
      '<details ontoggle="alert(1)" open><summary>x</summary></details>',
      "<details><summary>x<script>alert(1)</script></summary></details>",
      '<span class="mention" data-artifact="x" onclick="alert(1)">x</span>',
      '<a class="mention" href="https://example.com/">x</a>',
      '<a class="mention" href="/artifacts/x">x</a>',
      '<pre><code class="language-js" style="background:url(https://x.example/a.png)">x</code></pre>',
      '<mark style="background-image:image-set(\'x.png\' 1x)">x</mark>',
      '<figure><img src="https://example.com/p.png"></figure>',
      '<figure><img src="data:image/png;base64,AA" srcset="https://x.example/a.png 2x"></figure>',
      '<aside class="callout"><style>*{}</style></aside>',
      '<summary><iframe src="data:text/html,x"></iframe></summary>',
      "<details><summary>x</summary><article>y</article></details>",
    ];
    for (const html of refused) expect(() => docEditOf(html), html).toThrow();
  });
});

describe("the owner's edit to a doc, parsed", () => {
  it("takes the editor's blocks and the doc's structure, written back out as parsed", () => {
    const made =
      '<h2 id="water">Water</h2><p>it is <strong>wet</strong> <code>now</code> <a href="#water">up</a></p><ul class="checklist"><li data-checked="true">Tanks</li></ul>' +
      '<hr><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><aside class="callout"><p>Note</p></aside>' +
      '<figure><img src="data:image/png;base64,iVBORw0KGgo=" alt="plot"><figcaption>plot</figcaption></figure><blockquote class="pull">q</blockquote><p>a<span class="fn">note</span></p>';
    expect(docEditOf(made)).toBe(made);
    // A chart in a figure is SVG, with its own case kept.
    expect(docEditOf('<figure><svg viewBox="0 0 10 10"><linearGradient id="g"><stop offset="0"></stop></linearGradient><path d="M0 0L10 10" stroke="currentColor"></path></svg></figure>')).toContain('viewBox="0 0 10 10"');
    // Prose that only mentions code is text.
    expect(docEditOf("<p>Set onload = fast, and javascript: the language.</p>")).toContain("onload = fast");
  });

  it("cannot be ended early: a stray end tag is dropped, and what is saved is the parse", () => {
    expect(docEditOf("<p>one</p></article><p>two")).toBe("<p>one</p><p>two</p>");
    expect(docEditOf("<p>a < b & c</p>")).toBe("<p>a &lt; b &amp; c</p>");
  });

  it("refuses code and ways out however they are written", () => {
    const code = [
      '<img alt=">" src=x onerror="x()">',
      '<img alt=">" src="data:image/png;base64,AA" onerror="x()">',
      '<a href="&#106;avascript:x()">a</a>',
      '<a href="java&#x09;script:x()">a</a>',
      '<a href="  JAVASCRIPT:x()">a</a>',
      '<IMG SRC="data:image/png;base64,AA" ONERROR="x()">',
      '<img\nsrc="data:image/png;base64,AA"\nonerror\n=\n"x()">',
      "<img src=data:image/png;base64,AA onerror=x()>",
      '<p title="</p><script>x()</script>">a</p><script>x()</script>',
      "<p style=\"background:url(https://x.example/p.png)\">a</p>",
      "<template><img src=x onerror=x()></template>",
      "<details open ontoggle=x()>a</details>",
    ];
    for (const bad of code) expect(() => docEditOf(bad), bad).toThrow(/may not hold/);
    const leaves = [
      '<a title=">" href="https://evil.example">x</a>',
      '<a href="&#104;ttps://evil.example">x</a>',
      "<a href=//evil.example>x</a>",
      '<A HREF="HTTPS://evil.example">x</A>',
      '<a\nhref\n=\n"https://evil.example">x</a>',
      '<svg><a xlink:href="https://evil.example"><text>x</text></a></svg>',
      '<svg><a href="https://evil.example"><text>x</text></a></svg>',
      '<svg><image href="http://evil.example/p.png"></image></svg>',
      '<img srcset="https://evil.example/p.png 2x" src="data:image/png;base64,AAAA">',
      "<img src=https://evil.example/p.png>",
      "<iframe></iframe>",
      "<form><button>x</button></form>",
    ];
    for (const bad of leaves) expect(() => docEditOf(bad), bad).toThrow(/cannot leave its frame/);
    // A style or an SVG paint that loads, however it is spelled: a CSS escape, image-set, a url( that is not the page's own #id.
    const loads = [
      '<p style="background:u\\72l(https://x.example/p.png)">a</p>',
      '<p style="background:\\75rl(//x.example)">a</p>',
      '<p style="background-image:image-set(\'https://x.example/p.png\' 1x)">a</p>',
      '<p style="background-image:-webkit-image-set(\'//x.example/p.png\' 1x)">a</p>',
      '<p style="background:URL( https://x.example)">a</p>',
    ];
    for (const bad of loads) expect(() => docEditOf(bad), bad).toThrow(/a style that loads or runs something/);
    const paints = [
      '<svg><rect fill="url(https://x.example/p.svg#g)"></rect></svg>',
      '<svg><path stroke="url(//x.example/p.svg#g)"></path></svg>',
      '<svg><g mask="url(x.svg#m)"></g></svg>',
      '<svg><g clip-path="u\\72l(x.svg#c)"></g></svg>',
      '<svg><path marker-end="url(\'https://x.example/m.svg#m\')"></path></svg>',
      '<svg><use href="https://x.example/s.svg#a"></use></svg>',
      '<svg><use xlink:href="s.svg#a"></use></svg>',
      '<svg><filter><feImage href="https://x.example/p.png"></feImage></filter></svg>',
    ];
    for (const bad of paints) expect(() => docEditOf(bad), bad).toThrow(/may not hold/);
    // Within the page is the page's own.
    expect(docEditOf('<svg><defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)" clip-path="url( \'#c\')"></rect><use href="#g"></use></svg>')).toContain('fill="url(#g)"');
    // What a doc is not made of is refused by name.
    expect(() => docEditOf("<marquee>x</marquee>")).toThrow(/<marquee>/);
    expect(() => docEditOf('<p contenteditable="true">x</p>')).toThrow(/attribute contenteditable/);
  });
});

describe("an agent's page, parsed for its exits", () => {
  it("finds a link or a fetch off the page behind entities, quoted >, case and new lines", () => {
    const off = [
      '<a title=">" href="https://evil.example">x</a>',
      '<a href="&#104;ttps://evil.example">x</a>',
      '<A\nHREF="HTTPS://evil.example">x</A>',
      "<a href=//evil.example>x</a>",
      '<svg><a xlink:href="https://evil.example"><text>x</text></a></svg>',
      '<a href="&#106;avascript:location=1">x</a>',
    ];
    for (const html of off) expect(markupExits(html), html).toContain("a link off the page (link within it with #id)");
    expect(markupExits('<img alt=">" src="https://evil.example/p.png">')).toContain("an image or media from the network (inline it as data:)");
    expect(markupExits('<img srcset="data:image/png;base64,AA 1x, //evil.example/p.png 2x">')).toContain("an image or media from the network (inline it as data:)");
    expect(markupExits('<p title="<iframe>">x</p><LINK rel=prefetch href=//x>')).toEqual(["a <link> (a page loads nothing; prefetch and prerender links reach the network)"]);
    expect(markupExits("<template><iframe></iframe></template>")).toEqual(["a frame, object or embed"]);
    const svg = "an SVG <use> or <feImage> from outside the page (refer within it with #id)";
    for (const html of ['<svg><use href="https://x.example/s.svg#a"/></svg>', '<svg><use xlink:href="//x.example/s.svg#a"/></svg>', '<svg><filter><feImage href="https://x.example/p.png"/></filter></svg>', '<svg><use href="s.svg#a"/></svg>']) {
      expect(markupExits(html), html).toContain(svg);
    }
    expect(markupExits('<svg><symbol id="a"></symbol><use href="#a"/><filter><feImage href="data:image/png;base64,AA"/></filter></svg>')).toEqual([]);
  });

  it("leaves a page's own links and code alone", () => {
    expect(markupExits('<a href="#top">Top</a><a href="javascript:void 0">x</a><img src="data:image/png;base64,AA"><p title="https://x.example">t</p>')).toEqual([]);
  });
});
