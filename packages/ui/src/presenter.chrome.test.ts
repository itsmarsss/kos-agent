import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The presenter view and its audience window in a real Chrome: the
 * dashboard's own components (DeckPresenter, AudienceWindow, ArtifactPage),
 * bundled, around the deck runtime in its sandboxed frames. A press opens the
 * audience window as a pop-up, and both windows stay on one slide across
 * next and prev, from either one. Skipped without Chrome.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
const BOUND_MS = 15_000;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DECK = {
  record: { id: "pitch", projectSlug: null, title: "Garden pitch", path: "", updatedAt: 1, kind: "html", artifactKind: "deck" },
  kind: "html",
  page: {
    id: "pitch",
    title: "Garden pitch",
    kind: "deck",
    html: `<main data-deck><section class="title"><h1>Westside garden</h1><aside class="notes">Open with the harvest.</aside></section><section><h2>Harvest</h2><aside class="notes"><p>Say the number.</p></aside></section><section><h2>Water</h2></section><section class="closing"><h2>Vote</h2></section></main>`,
  },
};

/** The page under test: the presenter, opened from a press as the viewer opens it, or the audience window at its route. */
const ENTRY = `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { AudienceWindow } from "./AudienceWindow.js";
import { DeckPresenter } from "./DeckPresenter.js";
import { audienceRoute, openAudience } from "./presentlink.js";
const deck = ${JSON.stringify(DECK)};
const session = "0123456789abcdef01234567";
function Presenter() {
  const [audience, setAudience] = useState();
  if (audience === undefined) return h("button", { id: "go", style: { width: "200px", height: "60px" }, onClick: () => setAudience(openAudience("pitch", session)) }, "Present with notes");
  return h(DeckPresenter, { record: deck.record, page: deck.page, start: 0, count: 4, session, audience, onEnd: () => setAudience(undefined) });
}
const at = audienceRoute(location.hash);
createRoot(document.getElementById("root")).render(at ? h(AudienceWindow, at) : h(Presenter));
`;

describe.skipIf(!CHROME)("the presenter view and its audience window in a real Chrome", () => {
  let host: Server;
  let chrome: ChildProcess;
  let profile = "";
  let base = "";
  let ws: WebSocket;
  let n = 0;
  const wait = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  const raw = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const timer = setTimeout(() => (wait.delete(id), reject(new Error(`Chrome did not answer ${method}`))), BOUND_MS);
      wait.set(id, (m) => (clearTimeout(timer), wait.delete(id), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  /** Each window's sessions, its frames' too, as Chrome attaches them. */
  const children = new Map<string, string[]>();

  beforeAll(async () => {
    const { build } = await import("esbuild");
    const here = import.meta.dirname;
    const bundle = async (entry: { contents: string } | string): Promise<string> =>
      (
        await build({
          ...(typeof entry === "string" ? { entryPoints: [entry] } : { stdin: { contents: entry.contents, resolveDir: here, loader: "tsx" } }),
          bundle: true,
          write: false,
          format: typeof entry === "string" ? "iife" : "esm",
          target: "chrome120",
          jsx: "automatic",
          charset: "ascii",
          logLevel: "silent",
          define: { "process.env.NODE_ENV": '"production"' },
          plugins: [
            {
              name: "raw",
              setup(b) {
                b.onResolve({ filter: /\?raw$/ }, async (a) => ({ path: (await b.resolve(a.path.replace(/\?raw$/, ""), { resolveDir: a.resolveDir, kind: "import-statement" })).path, namespace: "raw" }));
                b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
              },
            },
          ],
        })
      ).outputFiles[0]!.text;
    const app = await bundle({ contents: ENTRY });
    const deckRuntime = await bundle(join(here, "../pagelib/deck.ts"));
    host = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/app.js")) return void res.writeHead(200, { "content-type": "text/javascript" }).end(app);
      if (url.startsWith("/page-lib/kos-deck.js")) return void res.writeHead(200, { "content-type": "text/javascript" }).end(deckRuntime);
      if (url.startsWith("/api/pages/pitch")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(DECK));
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body>`);
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "kos-presenter-chrome-"));
    const port = 9800 + Math.floor(Math.random() * 150);
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 300 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => undefined);
      if (!version) await pause(100);
    }
    ws = new WebSocket(version!.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: { sessionId?: string }; sessionId?: string };
      if (m.id) wait.get(m.id)?.(m as never);
      // A frame of a window, attached on its own (a sandboxed frame may run out of process): kept under the window's session.
      if (m.method === "Target.attachedToTarget" && m.sessionId && m.params?.sessionId) {
        children.get(m.sessionId)?.push(m.params.sessionId);
        children.set(m.params.sessionId, []);
        void raw("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId).catch(() => undefined);
      }
    };
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

  const open = async (targetId: string): Promise<string> => {
    const s = (await raw("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;
    children.set(s, []);
    await raw("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s);
    return s;
  };
  const value = async (s: string, expression: string): Promise<unknown> => ((await raw("Runtime.evaluate", { expression, returnByValue: true }, s)).result as { value?: unknown } | undefined)?.value;
  const until = async (seen: () => Promise<boolean>, what: string): Promise<void> => {
    for (const end = Date.now() + BOUND_MS; !(await seen()); await pause(50)) if (Date.now() >= end) throw new Error(`Waited for ${what}`);
  };
  /** The slides each deck frame under a window shows, read in the frames themselves, wherever they run. */
  const shown = async (s: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (session: string): Promise<void> => {
      // Every frame this session's process runs, each in a world of its own, so the page's own script is not asked.
      const tree = await raw("Page.getFrameTree", {}, session).catch(() => undefined);
      for (const id of tree ? frameIds((tree as { frameTree: FrameTree }).frameTree) : []) {
        const world = await raw("Page.createIsolatedWorld", { frameId: id }, session).catch(() => undefined);
        if (!world) continue;
        const said = await raw("Runtime.evaluate", { expression: `document.querySelector(".deck-slide.current")?.dataset.number ?? ""`, contextId: world.executionContextId, returnByValue: true }, session).catch(() => undefined);
        const at = (said?.result as { value?: string } | undefined)?.value;
        if (at) out.push(at);
      }
      for (const c of children.get(session) ?? []) await walk(c);
    };
    await walk(s);
    return out;
  };
  const key = async (s: string, k: string, code: number): Promise<void> => {
    for (const type of ["rawKeyDown", "keyUp"]) await raw("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code }, s);
  };

  it("opens the audience window from a press and keeps it on the presenter's slide across next and prev, from either window", async () => {
    const { targetId } = (await raw("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const presenter = await open(targetId);
    await raw("Page.enable", {}, presenter);
    await raw("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, presenter);
    await raw("Page.navigate", { url: `${base}/` }, presenter);
    await until(async () => (await value(presenter, `!!document.getElementById("go")`)) === true, "the press");
    // A real press, so the pop-up is the owner's.
    for (const type of ["mousePressed", "mouseReleased"]) await raw("Input.dispatchMouseEvent", { type, x: 100, y: 30, button: "left", clickCount: 1 }, presenter);
    let audienceId: string | undefined;
    await until(async () => {
      const { targetInfos } = (await raw("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
      audienceId = targetInfos.find((t) => t.type === "page" && t.url.includes("#/audience/pitch/"))?.targetId;
      return audienceId !== undefined;
    }, "the audience window");
    const audience = await open(audienceId!);
    await raw("Page.enable", {}, audience);
    const count = (): Promise<unknown> => value(presenter, `document.querySelector(".presenter-count")?.textContent`);
    await until(async () => (await value(presenter, `document.querySelector(".presenter-acts")?.textContent.includes("Audience window open") === true`)) === true, "the audience window to say it is up");
    // The presenter's slide and the next one, and the audience's: 1, 2 and 1.
    const all = async (want: string[], who: string): Promise<void> => until(async () => JSON.stringify([...(await shown(presenter))].sort()) === JSON.stringify([...want].sort()), `${who}: the presenter's slides ${want.join(", ")}`);
    const room = async (want: string): Promise<void> => until(async () => JSON.stringify(await shown(audience)) === JSON.stringify([want]), `the audience on slide ${want}`);
    await all(["1", "2"], "at the start");
    await room("1");
    expect(await value(presenter, `document.querySelector(".presenter-notes-body").textContent`)).toBe("Open with the harvest.");

    await key(presenter, "ArrowRight", 39);
    await all(["2", "3"], "after next");
    await room("2");
    expect(await count()).toBe("Slide 2 of 4");
    expect(await value(presenter, `document.querySelector(".presenter-notes-body").textContent`)).toBe("Say the number.");

    await key(presenter, "ArrowRight", 39);
    await room("3");
    await key(presenter, "ArrowLeft", 37);
    await all(["2", "3"], "after prev");
    await room("2");

    // A key in the audience window moves the room, and the presenter follows.
    await key(audience, "ArrowRight", 39);
    await room("3");
    await until(async () => (await count()) === "Slide 3 of 4", "the presenter to follow the audience");
    await all(["3", "4"], "after the audience's next");

    /*
     * Keys back to back, each before the frames have said where the last one
     * took them, pressed in the page a task apart so no report lands between
     * two. Every window ends where the keys did; once the presenter shows the
     * last place it shows no other, and the audience never says it moved.
     */
    await value(presenter, `(() => { window.__seen = []; window.__moved = 0; new MutationObserver(() => window.__seen.push(document.querySelector(".presenter-count").textContent)).observe(document.querySelector(".presenter-count"), { childList: true, subtree: true, characterData: true }); const c = new BroadcastChannel("kos-present:0123456789abcdef01234567"); c.onmessage = (e) => { if (e.data && e.data.type === "moved") window.__moved += 1; }; return true; })()`);
    const burst = async (from: number, keys: string[]): Promise<void> => {
      // The places the keys pass through, one a key: all the presenter may show, and in this order.
      const path = keys.reduce<number[]>((p, k) => [...p, Math.max(1, Math.min(4, (p.at(-1) ?? from) + (k === "ArrowRight" ? 1 : -1)))], []);
      const last = path.at(-1)!;
      await value(presenter, `window.__seen = []`);
      await raw("Runtime.evaluate", { expression: `(async () => { for (const k of ${JSON.stringify(keys)}) { dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 0)); } })()`, awaitPromise: true }, presenter);
      const words = `Slide ${last} of 4`;
      await until(async () => (await count()) === words, `the presenter on slide ${last}`);
      await all([String(last), String(last + 1)], `after ${keys.join(", ")}`);
      await room(String(last));
      await pause(600);
      const seen = (await value(presenter, `window.__seen`)) as string[];
      expect(seen).toEqual(path.map((n) => `Slide ${n} of 4`));
      expect(await count()).toBe(words);
      expect(await shown(audience)).toEqual([String(last)]);
      expect(await value(presenter, `window.__moved`)).toBe(0);
    };
    // From 3: forward, back, back, forward, back.
    await burst(3, ["ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowRight", "ArrowLeft"]);
    // There and back: from 2, next, next, prev.
    await burst(2, ["ArrowRight", "ArrowRight", "ArrowLeft"]);

    // Escape ends it, and the audience window closes with it.
    await key(presenter, "Escape", 27);
    await until(async () => {
      const { targetInfos } = (await raw("Target.getTargets")) as { targetInfos: { url: string }[] };
      return !targetInfos.some((t) => t.url.includes("#/audience/"));
    }, "the audience window to close");
  }, 90_000);
});

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}
const frameIds = (t: FrameTree): string[] => [t.frame.id, ...(t.childFrames ?? []).flatMap(frameIds)];
