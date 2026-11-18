import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Finder's columns in a real Chrome, with the dashboard's own sheets:
 * a fit measures what a cell draws, narrower as well as wider; a Finder
 * narrower than the kept widths narrows the other columns before Name goes
 * under its least; and a drag moves the grid on the list while the pointer
 * is down, keeping the width when it is let go. Skipped without Chrome.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
const BOUND_MS = 15_000;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A list in a box of a given width, its rows' kinds as given; `mount` draws it again from what the browser keeps. */
const ENTRY = `
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { ListView } from "./ListView.js";
const noop = () => undefined;
const handlers = { selected: new Set(), lead: null, editing: null, over: null, press: noop, open: noop, menu: noop, renamed: noop, drag: () => ({ draggable: true, onDragStart: noop, onDragEnd: noop }), drop: () => ({ onDragOver: noop, onDragLeave: noop, onDrop: noop }) };
let root;
window.mount = (width, names) => {
  root?.unmount();
  const box = document.getElementById("root");
  box.style.width = width + "px";
  root = createRoot(box);
  const rows = names.map((name) => ({ entry: { name, path: name, kind: "file", size: 10, modifiedAt: 1 }, depth: 0 }));
  root.render(h("div", { className: "finder" }, h("div", { className: "finder-main" }, h(ListView, { rows, sort: { key: "name", desc: false }, onSort: noop, h: handlers, empty: "Empty" }))));
};
`;

describe.skipIf(!CHROME)("the Finder's columns in a real Chrome", () => {
  let host: Server;
  let chrome: ChildProcess;
  let profile = "";
  let base = "";
  let ws: WebSocket;
  let n = 0;
  const wait = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  const raw = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const timer = setTimeout(() => (wait.delete(id), reject(new Error(`Chrome did not answer ${method}`))), BOUND_MS);
      wait.set(id, (m) => (clearTimeout(timer), wait.delete(id), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
      ws.send(JSON.stringify({ id, method, params, sessionId: session }));
    });
  let session = "";
  const value = async <T>(expression: string): Promise<T> => ((await raw("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result as { value: T }).value;
  const mouse = (type: string, x: number, y: number, clickCount = 1): Promise<unknown> => raw("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
  /** The head's columns as drawn, Name first. */
  const drawn = (): Promise<number[]> => value(`[...document.querySelectorAll('.finder-list-head [role=columnheader]')].map((c) => Math.round(c.getBoundingClientRect().width))`);
  /** Whether every cell of a column draws all it holds. */
  const fits = (key: string): Promise<boolean> => value(`[...document.querySelectorAll('.finder-row [data-col="${key}"]')].every((c) => c.scrollWidth <= c.clientWidth)`);
  const centre = (label: string): Promise<{ x: number; y: number }> => value(`(() => { const r = document.querySelector('[aria-label="Resize ${label}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const mount = async (width: number, names: string[], kept?: Record<string, number>): Promise<void> => {
    await value(`localStorage.${kept ? `setItem("kos.finder.columns", ${JSON.stringify(JSON.stringify(kept))})` : `removeItem("kos.finder.columns")`}; mount(${width}, ${JSON.stringify(names)}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  };

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const here = import.meta.dirname;
    const app = (await build({ stdin: { contents: ENTRY, resolveDir: here, loader: "tsx" }, bundle: true, write: false, format: "esm", target: "chrome120", jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" } })).outputFiles[0]!.text;
    const css = ["../../../kit/src/kit.css", "../styles.css"].map((p) => readFileSync(join(here, p), "utf8")).join("\n");
    host = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/app.js")) return void res.writeHead(200, { "content-type": "text/javascript" }).end(app);
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html data-theme="dark"><head><style>${css}</style></head><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "kos-columns-chrome-"));
    const port = 9800 + Math.floor(Math.random() * 150);
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
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
    await raw("Emulation.setDeviceMetricsOverride", { width: 1200, height: 600, deviceScaleFactor: 1, mobile: false });
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

  it("fits a column to what its cells draw, narrowing a wide one and widening a narrow one", async () => {
    await mount(1000, ["a.md", "b.md"], { modified: 184, size: 88, kind: 400 });
    expect((await drawn())[3]).toBe(400);
    const at = await centre("Kind");
    await mouse("mousePressed", at.x, at.y, 1);
    await mouse("mouseReleased", at.x, at.y, 1);
    await mouse("mousePressed", at.x, at.y, 2);
    await mouse("mouseReleased", at.x, at.y, 2);
    const narrowed = (await drawn())[3]!;
    // "Markdown" and the head's "Kind", with the cell's padding: well under the 400 it was, and all of it drawn.
    expect(narrowed).toBeGreaterThan(72);
    expect(narrowed).toBeLessThan(120);
    expect(await fits("kind")).toBe(true);
    expect(JSON.parse((await value<string>(`localStorage.getItem("kos.finder.columns")`)) ?? "null")).toMatchObject({ kind: narrowed });

    await mount(1000, ["a-file-with-a-long-name.webmanifest"], { modified: 184, size: 88, kind: 72 });
    expect(await fits("kind")).toBe(false);
    await value(`(() => { const d = document.querySelector('[aria-label="Resize Kind"]'); d.focus(); d.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    await pause(50);
    expect((await drawn())[3]).toBeGreaterThan(72);
    expect(await fits("kind")).toBe(true);
  });

  it("narrows the other columns before Name in a Finder too narrow for the kept widths", async () => {
    await mount(1000, ["a.md"], { modified: 400, size: 300, kind: 300 });
    const [name, modified, size, kind] = await drawn();
    expect(name).toBeGreaterThanOrEqual(176);
    expect(modified! + size! + kind!).toBeLessThan(1000);
    expect(await value<boolean>(`(() => { const l = document.querySelector('.finder-list'); return l.scrollWidth <= l.clientWidth; })()`)).toBe(true);
    // Just above the width where the list turns to one column: Name at its least, the others sharing the rest, none under theirs.
    await mount(660, ["a.md"], { modified: 400, size: 300, kind: 300 });
    const narrow = await drawn();
    expect(narrow[0]).toBe(176);
    expect(narrow[1]).toBeGreaterThanOrEqual(96);
    expect(narrow[2]).toBeGreaterThanOrEqual(56);
    expect(narrow[3]).toBeGreaterThanOrEqual(72);
    expect(await value<boolean>(`(() => { const l = document.querySelector('.finder-list'); return l.scrollWidth <= l.clientWidth; })()`)).toBe(true);
    // What a divider says it can reach is what the room allows, not the most any column may be.
    await mount(1000, ["a.md"]);
    const max = Number(await value<string>(`document.querySelector('[aria-label="Resize Kind"]').getAttribute("aria-valuemax")`));
    const [nameNow, , , kindNow] = await drawn();
    expect(max).toBe(Math.min(480, kindNow! + nameNow! - 176));
  });

  it("moves the grid while the pointer is down and keeps the width once it is let go", async () => {
    await mount(1000, ["a.md", "b.md"]);
    const at = await centre("Date Modified");
    await mouse("mousePressed", at.x, at.y);
    expect(await value<boolean>(`document.querySelector('[aria-label="Resize Date Modified"]').classList.contains("is-dragging")`)).toBe(true);
    for (let i = 1; i <= 5; i++) await mouse("mouseMoved", at.x - i * 20, at.y);
    expect((await drawn())[1]).toBe(284);
    expect(await value<string | null>(`localStorage.getItem("kos.finder.columns")`)).toBeNull();
    await mouse("mouseReleased", at.x - 100, at.y);
    expect(JSON.parse((await value<string>(`localStorage.getItem("kos.finder.columns")`)) ?? "null")).toEqual({ modified: 284, size: 88, kind: 152 });
    expect(await value<boolean>(`document.querySelector('[aria-label="Resize Date Modified"]').classList.contains("is-dragging")`)).toBe(false);
    expect((await drawn())[1]).toBe(284);
  });
});
