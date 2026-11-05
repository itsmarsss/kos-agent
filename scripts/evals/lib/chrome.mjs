// A headless Chrome of the run's own, driven over CDP: the fake Mac's screen and KOS for Chrome both live in it.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.KOS_EVAL_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launchChrome() {
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "kos-eval-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging", "--no-first-run", "--hide-scrollbars", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let ver;
  for (let i = 0; i < 300 && !ver; i++) {
    ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => undefined);
    if (!ver) await sleep(100);
  }
  if (!ver) throw new Error("headless Chrome did not start");
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  };
  /** One CDP command, given up after 30 seconds rather than hung on. */
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const k = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(k);
        rej(new Error(`${method}: no answer in 30 s`));
      }, 30_000);
      waiting.set(k, (m) => {
        clearTimeout(timer);
        if (m.error) rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
        else res(m.result ?? {});
      });
      ws.send(JSON.stringify({ id: k, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const open = async (url) => {
    const { targetId } = await send("Target.createTarget", { url });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, session: sessionId };
  };
  const evaluate = async (session, expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session)).result?.value;
  const close = () => {
    try {
      ws.close();
    } catch {
      /* closed */
    }
    proc.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500).unref();
  };
  return { send, open, evaluate, close };
}
