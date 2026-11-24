import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Where the toasts land against an open sheet, in a real Chrome with the
 * dashboard's own stylesheets. The stack is drawn over every sheet, so a note
 * raised from inside one is seen; it must still never lie on a field or a
 * button of the sheet on top. Three notes, the tallest stack there is, over
 * a drawer, a wide drawer, the palette and a dialog, at a desk, a narrow
 * window and a phone. Skipped without Chrome.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
const BOUND_MS = 15_000;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The sheets as the dashboard draws them, the toast host, and a way to raise the notes. */
const ENTRY = `
import { createElement as h, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { domMax, LazyMotion, MotionConfig } from "motion/react";
import { SheetFoot } from "@kos/kit";
import { Drawer } from "./Drawer.js";
import { Modal } from "./Modal.js";
import { ToastHost, toast, dismissToast } from "./Toast.js";
const noop = () => {};
const foot = h(SheetFoot, { note: "Give it a name first.", onCancel: noop, primary: h("button", { type: "button", className: "btn btn--primary" }, "Create") });
const form = h(Fragment, null,
  h("label", { className: "field" }, "Name", h("input", { className: "input", autoFocus: true })),
  h("label", { className: "field" }, "Kind", h("select", { className: "input" }, h("option", null, "Project"))));
const SHEETS = {
  none: () => null,
  drawer: () => h(Drawer, { open: true, title: "New project", onClose: noop, footer: foot }, form),
  wide: () => h(Drawer, { open: true, wide: true, title: "A run", onClose: noop, footer: foot }, form),
  modal: () => h(Modal, { open: true, title: "New artifact", onClose: noop, footer: foot }, form),
  palette: () => h("div", { className: "pal-wrap" },
    h("div", { className: "pal", role: "dialog" },
      h("input", { className: "pal-input", placeholder: "Search everything" }),
      h("button", { type: "button", className: "btn btn--ghost pal-cancel" }, "Cancel"),
      h("ul", { className: "pal-list", role: "listbox" }, ["Open KOS", "New chat", "Settings"].map((t) => h("li", { key: t, role: "option", className: "pal-item" }, t))))),
};
let root = null;
let ids = [];
window.show = (sheet) => {
  // A fresh host each time, so the last sheet's notes are not still on their way out.
  root?.unmount();
  for (const id of ids) dismissToast(id);
  root = createRoot(document.getElementById("root"));
  root.render(h(LazyMotion, { features: domMax, strict: true }, h(MotionConfig, { reducedMotion: "always" }, h(ToastHost), SHEETS[sheet]())));
  ids = [
    toast({ kind: "ok", text: "Saved" }, null),
    toast({ kind: "err", text: "Could not reach the schedule runner; it will try again in a minute." }, null),
    toast({ kind: "ok", text: "Archived the Lisbon trip", undo: noop }, null),
  ];
};
`;

/** Each note against each control of the sheet on top, and whether each note is the thing drawn at its own centre. */
const MEASURE = `(() => {
  const stack = document.querySelector(".ops-toasts");
  const notes = [...stack.querySelectorAll(".ops-toast")].map((n) => n.getBoundingClientRect());
  const sheet = [...document.querySelectorAll(".pal, .modal, .drawer")].at(-1);
  const hits = [];
  for (const el of sheet ? sheet.querySelectorAll("input, select, textarea, button, [role=option]") : []) {
    const r = el.getBoundingClientRect();
    if (notes.some((q) => Math.min(r.right, q.right) > Math.max(r.left, q.left) && Math.min(r.bottom, q.bottom) > Math.max(r.top, q.top))) hits.push(el.textContent || el.tagName);
  }
  const seen = notes.every((q) => stack.contains(document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2)));
  const inside = notes.every((q) => q.left >= 0 && q.top >= 0 && q.right <= innerWidth && q.bottom <= innerHeight);
  const texts = [...stack.querySelectorAll(".ops-toast-text")].map((n) => n.textContent);
  return { count: notes.length, hits, seen, inside, texts, right: Math.round(Math.max(...notes.map((q) => q.right))), top: Math.round(Math.min(...notes.map((q) => q.top))) };
})()`;

interface Measured {
  count: number;
  hits: string[];
  seen: boolean;
  inside: boolean;
  texts: string[];
  right: number;
  top: number;
}

const WINDOWS = [
  { name: "a desk", width: 1440, height: 900, coarse: false },
  { name: "a narrow window", width: 1024, height: 768, coarse: false },
  { name: "a phone", width: 390, height: 844, coarse: true },
] as const;

describe.skipIf(!CHROME)("the toasts over an open sheet, in a real Chrome", () => {
  let host: Server;
  let chrome: ChildProcess;
  let profile = "";
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
  const shown = async (sheet: string): Promise<Measured> => {
    await value(`show(${JSON.stringify(sheet)})`);
    // Past the layout animation's settling, reduced motion or not.
    await pause(300);
    return value<Measured>(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => ${MEASURE})`);
  };

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const here = import.meta.dirname;
    const app = (await build({ stdin: { contents: ENTRY, resolveDir: here, loader: "tsx" }, bundle: true, write: false, format: "esm", target: "chrome120", jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" } })).outputFiles[0]!.text;
    // In main.tsx's order: the kit, its scrollbars, the dashboard, then the finger's rules.
    const css = ["../../kit/src/kit.css", "../../kit/src/scrollbars.css", "styles.css", "touch.css"].map((p) => readFileSync(join(here, p), "utf8")).join("\n");
    host = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/app.js")) return void res.writeHead(200, { "content-type": "text/javascript" }).end(app);
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "kos-toast-chrome-"));
    const port = 9950 + Math.floor(Math.random() * 40);
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--use-mock-keychain", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
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
    await raw("Page.navigate", { url: base });
    for (const end = Date.now() + BOUND_MS; !(await value<boolean>(`typeof window.show === "function"`).catch(() => false)); await pause(50)) if (Date.now() >= end) throw new Error("the page did not load");
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

  for (const w of WINDOWS) {
    describe(`at ${w.name}`, () => {
      beforeAll(async () => {
        await raw("Emulation.setDeviceMetricsOverride", { width: w.width, height: w.height, deviceScaleFactor: 1, mobile: w.coarse });
        await raw("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: w.coarse ? "coarse" : "fine" }, { name: "hover", value: w.coarse ? "none" : "hover" }] });
      });

      it("keeps to the top-right corner with no sheet open, newest first", async () => {
        const m = await shown("none");
        expect(m.count).toBe(3);
        expect(m.texts[0]).toBe("Archived the Lisbon trip");
        expect(m.right).toBe(w.width - 16);
        expect(m.inside).toBe(true);
      }, 30_000);

      for (const [sheet, name] of [["drawer", "a drawer"], ["wide", "a wide drawer"], ["modal", "a dialog"], ["palette", "the palette"]] as const) {
        it(`lies on none of ${name}'s fields or buttons, and is seen over it`, async () => {
          const m = await shown(sheet);
          expect(m.count).toBe(3);
          expect(m.hits).toEqual([]);
          expect(m.seen).toBe(true);
          expect(m.inside).toBe(true);
        }, 30_000);
      }
    });
  }
});
