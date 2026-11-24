import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The composer's caret against its words, in a real Chrome with the
 * dashboard's own sheets. The words are drawn by a mirror under a textarea
 * whose own words are transparent, so a caret is only where it looks when
 * both lay the text out alike. For sampled characters, the centre of the
 * glyph the mirror draws is hit-tested with caretPositionFromPoint, which
 * answers from the textarea: it must land on that character. Typed until the
 * box is at its ceiling and scrolls, at a desk and under a finger, with the
 * scrollbars Chrome really draws. Skipped without Chrome.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
const BOUND_MS = 15_000;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The composer as ChatsPage draws it: the box, the field, the mirror, the growth. */
const ENTRY = `
import { createElement as h, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HighlightedInput } from "./HighlightedInput.js";
import { useAutoGrow } from "./composer.js";
function Composer() {
  const [draft, setDraft] = useState("");
  const ref = useRef(null);
  useAutoGrow(ref, draft, 12);
  return h("div", { className: "composer-box" },
    h("div", { className: "composer-input" },
      h(HighlightedInput, { value: draft, textareaRef: ref },
        h("textarea", { className: "hl-area", ref, rows: 1, value: draft, onChange: (e) => setDraft(e.target.value) }))));
}
window.mount = (width) => {
  const box = document.getElementById("root");
  box.style.width = width + "px";
  window.composer?.unmount();
  window.composer = createRoot(box);
  window.composer.render(h(Composer));
};
`;

/** What the textarea's caret makes of the mirror's glyphs, and the two boxes' scrolling and metrics. */
const MEASURE = `(() => {
  const ta = document.querySelector("textarea.hl-area");
  const mirror = document.querySelector(".hl-mirror");
  const runs = [];
  const walk = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
  for (let at = 0; walk.nextNode(); at += walk.currentNode.data.length) runs.push([walk.currentNode, at]);
  const nodeAt = (i) => { for (let k = runs.length - 1; k >= 0; k--) if (runs[k][1] <= i) return [runs[k][0], i - runs[k][1]]; };
  const box = ta.getBoundingClientRect();
  const clusters = [...new Intl.Segmenter().segment(ta.value)];
  const step = Math.max(1, Math.floor(clusters.length / 300));
  let checked = 0;
  const off = [];
  for (let c = 0; c < clusters.length; c += step) {
    const { index: i, segment } = clusters[c];
    if (/\\s/.test(segment)) continue;
    const [node, o] = nodeAt(i);
    const range = document.createRange();
    range.setStart(node, o);
    range.setEnd(node, Math.min(node.data.length, o + segment.length));
    const g = range.getClientRects()[0];
    if (!g || g.width === 0) continue;
    const x = g.left + g.width / 2, y = g.top + g.height / 2;
    if (y < box.top + 4 || y > box.bottom - 4) continue;
    const hit = document.caretPositionFromPoint(x, y);
    if (!hit) continue;
    checked++;
    if (hit.offset !== i && hit.offset !== i + segment.length) off.push([i, hit.offset]);
  }
  const ts = getComputedStyle(ta), ms = getComputedStyle(mirror);
  const props = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "wordBreak", "overflowWrap", "whiteSpace", "paddingTop", "paddingLeft", "paddingRight", "paddingBottom", "borderTopWidth", "borderLeftWidth"];
  return {
    checked,
    off: off.slice(0, 5),
    differ: props.filter((p) => ts[p] !== ms[p]).map((p) => p + ": " + ts[p] + " vs " + ms[p]),
    scrolls: ta.scrollHeight > ta.clientHeight,
    width: [ta.clientWidth, mirror.clientWidth],
    height: [ta.clientHeight, mirror.clientHeight],
    scrollTop: [Math.round(ta.scrollTop), Math.round(mirror.scrollTop)],
  };
})()`;

const LINES = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog and keeps running`).join("\n");
const DRAFTS: [string, string][] = [
  ["a paragraph that wraps", "word ".repeat(400).trim()],
  ["many short lines", LINES],
  ["a trailing newline", `${LINES}\n`],
  ["one unbroken word", `${"x".repeat(900)} tail`],
  ["emoji with modifiers", "Looks good \u{1F44D}\u{1F3FD} and \u{1F680} ".repeat(120)],
];

interface Measured {
  checked: number;
  off: [number, number][];
  differ: string[];
  scrolls: boolean;
  width: [number, number];
  height: [number, number];
  scrollTop: [number, number];
}

describe.skipIf(!CHROME)("the composer's caret in a real Chrome", () => {
  let host: Server;
  let chrome: ChildProcess;
  let profile = "";
  let base = "";
  let ws: WebSocket;
  let n = 0;
  let session = "";
  const wait = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  const raw = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const timer = setTimeout(() => (wait.delete(id), reject(new Error(`Chrome did not answer ${method}`))), BOUND_MS);
      wait.set(id, (m) => (clearTimeout(timer), wait.delete(id), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
      ws.send(JSON.stringify({ id, method, params, sessionId: session }));
    });
  const value = async <T>(expression: string): Promise<T> => {
    const out = (await raw("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string } } };
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? "the page threw");
    return out.result.value;
  };
  const frames = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";

  /** A fresh composer of the given width, typed into as a person types: in pieces, the browser keeping the caret in view. */
  const typed = async (width: number, text: string): Promise<void> => {
    await value(`mount(${width}); ${frames}`);
    await value(`document.querySelector("textarea.hl-area").focus()`);
    for (const piece of text.match(/[\s\S]{1,80}/gu) ?? []) await raw("Input.insertText", { text: piece });
    await value(frames);
  };
  const expectAligned = (m: Measured): void => {
    expect(m.differ).toEqual([]);
    expect(m.checked).toBeGreaterThan(10);
    expect(m.off).toEqual([]);
    expect(m.width[0]).toBe(m.width[1]);
    expect(m.height[0]).toBe(m.height[1]);
    expect(m.scrollTop[0]).toBe(m.scrollTop[1]);
  };

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const here = import.meta.dirname;
    const app = (await build({ stdin: { contents: ENTRY, resolveDir: here, loader: "tsx" }, bundle: true, write: false, format: "esm", target: "chrome120", jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" } })).outputFiles[0]!.text;
    // In main.tsx's order: the kit, its scrollbars, the dashboard, then the finger's rules.
    const css = ["../../kit/src/kit.css", "../../kit/src/scrollbars.css", "styles.css", "touch.css"].map((p) => readFileSync(join(here, p), "utf8")).join("\n");
    host = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/app.js")) return void res.writeHead(200, { "content-type": "text/javascript" }).end(app);
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html data-theme="dark"><head><style>${css}</style></head><body style="margin:0;padding:16px"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "kos-composer-chrome-"));
    const port = 9800 + Math.floor(Math.random() * 150);
    // No --hide-scrollbars: the lane a scrolling textarea takes is what this is about.
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--use-mock-keychain", "about:blank"], { stdio: "ignore" });
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 300 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => undefined);
      if (!version) await pause(100);
    }
    ws = new WebSocket(version!.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number };
      if (m.id) wait.get(m.id)?.(m as never);
    };
    const { targetId } = (await raw("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    session = ((await raw("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string }).sessionId;
    await raw("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await raw("Page.navigate", { url: base });
    for (const end = Date.now() + BOUND_MS; !(await value<boolean>(`typeof window.mount === "function"`).catch(() => false)); await pause(50)) if (Date.now() >= end) throw new Error("the page did not load");
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    if (chrome && chrome.exitCode === null) await new Promise((r) => (chrome.once("exit", r), chrome.kill()));
    host?.close();
    if (profile) {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // The OS clears tmp.
      }
    }
  });

  for (const [pointer, width] of [["fine", 860], ["coarse", 300]] as const) {
    describe(`under a ${pointer} pointer`, () => {
      beforeAll(async () => {
        await raw("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: pointer }, { name: "hover", value: pointer === "fine" ? "hover" : "none" }] });
      });

      for (const [name, text] of DRAFTS) {
        it(`keeps the caret on the words with ${name}, at its ceiling and scrolled to its foot`, async () => {
          await typed(width, text);
          const end = await value<Measured>(MEASURE);
          if (name !== "one unbroken word" || pointer === "coarse") expect(end.scrolls).toBe(true);
          expectAligned(end);
          await value(`(() => { const ta = document.querySelector("textarea.hl-area"); ta.scrollTop = ta.scrollHeight; })(); ${frames}`);
          expectAligned(await value<Measured>(MEASURE));
        }, 60_000);
      }

      it("keeps them together when the window narrows under a long draft", async () => {
        await typed(width, "word ".repeat(400).trim());
        await value(`document.getElementById("root").style.width = "${Math.round(width * 0.7)}px"; ${frames}`);
        expectAligned(await value<Measured>(MEASURE));
      }, 60_000);
    });
  }
});
