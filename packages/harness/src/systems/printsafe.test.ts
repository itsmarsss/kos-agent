import { describe, expect, it } from "vitest";

import { PRINT_CSP, plainCss, printCss, printDocument, withoutHints } from "./printsafe.js";

describe("a snapshot made safe to print", () => {
  it("keeps the page's markup and styles, under its own policy first in the head", () => {
    const out = printDocument('<html data-kind="doc"><head class="x"><style>h1{color:red}</style></head><body><h1 id="t" class="big">Plan</h1><p style="color:blue">Text <a href="#t">up</a></p><img src="data:image/png;base64,AAAA" alt="map"></body></html>');
    expect(out).toMatch(new RegExp(`^<!doctype html><html data-kind="doc"><head><meta http-equiv="Content-Security-Policy" content="${PRINT_CSP.replace(/[*+?^${}()|[\]\\]/g, "\\$&")}"><meta charset="utf-8"><style>h1{color:red}</style></head>`));
    expect(out).toContain('<h1 id="t" class="big">Plan</h1><p style="color:blue">Text <a href="#t">up</a></p><img src="data:image/png;base64,AAAA" alt="map">');
  });

  it("drops what runs, frames, loads or acts, in HTML, SVG and MathML", () => {
    const out = printDocument(
      `<head><meta http-equiv="refresh" content="0;url=http://x"><link rel="preconnect" href="http://x"><base href="http://x"><script>a()</script></head><body>` +
        `<iframe sandbox="allow-scripts" srcdoc="<script>new WebSocket('ws://x')</script>"></iframe><object data="http://x"></object><embed src="http://x"><noscript>n</noscript>` +
        `<form action="http://x"><input formaction="http://x"></form><portal src="http://x"></portal><template><script>b()</script></template>` +
        `<p onclick="c()" onmouseover="d()">kept</p><a href="javascript:e()">j</a><a href="http://x">off</a><img src="http://x/i.png"><img src=" java\tscript:f()">` +
        `<svg><script>g()</script><foreignObject><iframe srcdoc="h"></iframe></foreignObject><animate attributeName="href" to="javascript:i()"/><set attributeName="href" to="x"/><use href="http://x/s.svg#a"/><use href="#a"/><a xlink:href="javascript:j()"><text>t</text></a><image href="http://x/p.png"/><rect fill="url(http://x/p)" filter="url(#f)"/></svg>` +
        `<math><maction actiontype="toggle"><mi>x</mi></maction><annotation-xml encoding="text/html"><iframe></iframe></annotation-xml><mi>y</mi></math></body>`,
    );
    for (const gone of ["refresh", "preconnect", "<base", "<script", "a()", "<iframe", "srcdoc", "WebSocket", "<object", "<embed", "<noscript", "<form", "<input", "<portal", "<template", "onclick", "onmouseover", "javascript", "http://x", "<foreignObject", "<animate", "<set", "maction", "annotation-xml"]) {
      expect(out, gone).not.toContain(gone);
    }
    expect(out).toContain('<p>kept</p>');
    expect(out).toContain('<use href="#a"></use>');
    expect(out).toContain('<rect filter="url(#f)"></rect>');
    expect(out).toContain("<mi>y</mi>");
  });

  it("strips every url() to elsewhere and every @import from styles, keeping data: and #id", () => {
    expect(printCss('@import "http://x/a.css"; p{background:url(http://x/a.png);mask:url( "#m" )} @font-face{src:url(data:font/woff2;base64,AA)} b{background:image-set("http://x" 1x)}')).toBe(
      ' p{background:none;mask:url( "#m" )} @font-face{src:url(data:font/woff2;base64,AA)} b{background:none("http://x" 1x)}',
    );
    expect(printDocument('<p style="background:url(//x/y)">a</p>')).toContain('<p style="background:none">a</p>');
  });
});

describe("an artifact without its hints", () => {
  it("drops every link, meta and base, in any case and in a template, and keeps its scripts' text as written", () => {
    const out = withoutHints('<HEAD><LINK REL=preconnect href="http://x"><meta http-equiv=refresh content="0;url=http://x"><base href="http://x/"></HEAD><body><template><link rel="prefetch" href="http://x"></template><p>a</p><script>var s = "<link rel=x>";</script></body>');
    expect(out.replace(/<script>[\s\S]*?<\/script>/, "")).not.toMatch(/<link|<meta|<base/i);
    expect(out).toContain('<p>a</p><script>var s = "<link rel=x>";</script>');
  });
});

describe("the snapshot's ways round the print allowlist", () => {
  it("reads nothing but text in a style, SVG's too, and drops a frame, foreign content or a script at any depth", () => {
    const out = printDocument(
      `<body><svg><style><iframe srcdoc="<script>new WebSocket('ws://x')</script>"></iframe><foreignObject><script>a()</script></foreignObject>rect{fill:red}</style>` +
        `<g><g><g><foreignObject><div><iframe src="http://x"></iframe></div></foreignObject><script>b()</script></g></g></g></svg>` +
        `<math><mi><svg><frame src="http://x"></frame></svg></mi></math><div><div><span><iframe></iframe><frame></frame><script>c()</script></span></div></div></body>`,
    );
    for (const gone of ["<iframe", "srcdoc", "WebSocket", "<foreignObject", "<script", "<frame", "a()", "b()", "c()", "http://x"]) expect(out, gone).not.toContain(gone);
    expect(out).toContain("<style>rect{fill:red}</style>");
  });

  it("puts its policy first in the real head, as a node, whatever an attribute says", () => {
    const out = printDocument(`<html><head title="<head>"><style>p{}</style></head><body><p data-x="<head><script>x()</script>">a</p></body></html>`);
    expect(out.indexOf('<meta http-equiv="Content-Security-Policy"')).toBe(out.indexOf("<head>") + "<head>".length);
    // Left in its attribute, where it is text.
    expect(out).toContain(`<p data-x="<head><script>x()</script>">a</p>`);
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
    // A snapshot with no head still gets one, with the policy in it.
    expect(printDocument("<p>bare</p>")).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="[^"]+"><meta charset="utf-8"><\/head><body><p>bare<\/p><\/body><\/html>$/);
  });

  it("reads CSS escapes before it looks for a url or an @import, in styles and in SVG paint", () => {
    expect(plainCss("u\\rl(x) \\75 rl(y) @im\\port \\000075 rl(z) content:\"\\201C\\\"\"")).toBe('url(x) url(y) @import url(z) content:"\\201C\\""');
    for (const css of ["p{background:u\\rl(http://x/a)}", "p{background:\\75 rl(http://x/a)}", "@im\\port 'http://x/a.css'; p{}", "p{background:url(http://x/a"]) {
      // Whatever is left of the address is no url() any more: nothing loads it.
      expect(plainCss(printCss(css)), css).not.toMatch(/url\(|@import/i);
    }
    const svg = printDocument(`<svg><rect fill="u\\rl(http://x/p)" stroke="\\75 rl(http://x/q)" filter="url(#f)" mask="url(http://x/m)" clip-path="u\\72l(//x/c)" marker-end="url(http://x/e)" cursor="url(http://x/k), auto" style="fill:u\\rl(http://x/s)"/></svg>`);
    expect(svg).not.toContain("x/");
    expect(svg).toContain('filter="url(#f)"');
  });
});
