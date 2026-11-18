import { describe, expect, it } from "vitest";

import { cleanCss, sanitizeHtml } from "./sanitize.js";

describe("sanitizeHtml", () => {
  it("keeps what reads", () => {
    const html = '<h2>Plan</h2><p style="text-align:center;color:#c00">A <strong>b</strong> <em>c</em></p><table><tr><td colspan="2">x</td></tr></table><ul><li>one</li></ul>';
    expect(sanitizeHtml(html)).toBe('<h2>Plan</h2><p style="text-align:center;color:#c00">A <strong>b</strong> <em>c</em></p><table><tbody><tr><td colspan="2">x</td></tr></tbody></table><ul><li>one</li></ul>');
  });

  it.each([
    ["<script>alert(1)</script>ok", "ok"],
    ['<img src=x onerror="alert(1)">', ""],
    ['<img src="data:image/svg+xml;base64,PHN2Zz4=">', ""],
    ['<img src="data:image/png;base64,AAAA" onload="x()">', '<img src="data:image/png;base64,AAAA">'],
    ['<a href="javascript:alert(1)">link</a>', "link"],
    ['<a href="https://example.com">site</a>', "site"],
    ['<p onclick="x()" data-x="1" id="y">p</p>', "<p>p</p>"],
    ["<iframe src=//evil></iframe>after", "after"],
    ["<svg><script>alert(1)</script></svg>t", "t"],
    ['<math><mi xlink:href="javascript:alert(1)">m</mi></math>t', "t"],
    ["<form action=//x><input name=a></form>t", "t"],
    ['<meta http-equiv="refresh" content="0;url=//x">t', "t"],
    ['<base href="//evil/">t', "t"],
    ['<link rel=stylesheet href=//x>t', "t"],
    ['<object data=x></object><embed src=x>t', "t"],
    ['<p style="background:url(https://x/y.png);color:red">s</p>', '<p style="background:https://x/y.png);color:red">s</p>'],
    ['<p style="color:red;behavior:url(x.htc)">s</p>', '<p style="color:red;x.htc)">s</p>'],
    ['<p class="a&quot; onclick=&quot;x">c</p>', "<p>c</p>"],
    ['<td width="100" height="javascript:1">w</td>', '<td width="100">w</td>'],
    ["<noscript><p>hidden</p></noscript>v", "v"],
    ["<template><img src=x onerror=1></template>v", "v"],
    ["<p>a<!-- <script>x</script> -->b</p>", "<p>ab</p>"],
    ["<<script>alert(1)//<</script>", "&lt;"],
  ])("cleans %s", (input, output) => {
    expect(sanitizeHtml(input)).toBe(output);
  });

  it("keeps a top-level style made inert, and none deeper", () => {
    expect(sanitizeHtml('<style>@import "//x"; p { color: red } p > b { font: 12px Times } </style><p>t</p>')).toBe('<style> "//x"; p { color: red } p > b { font: 12px Times } </style><p>t</p>');
    expect(sanitizeHtml("<style>p{}</style><p>t<style>p{}</style></p>")).toBe("<style>p{}</style><p>t</p>");
    expect(sanitizeHtml("<style>p{}</style\\><p>t")).not.toContain("</style\\");
  });
});

describe("cleanCss", () => {
  it("removes what fetches or hides", () => {
    expect(cleanCss("a{b:url(x)} @import 'y'; c{d:expression(e)} f{g:\\75 rl(h)} @font-face{} -moz-binding:z image-set(")).not.toMatch(/url\(|@import|expression\(|\\|@font-face|-moz-binding|image-set\(/);
  });
});
