// A headless Chrome of the run's own, driven over CDP: the fake Mac's screen and KOS for Chrome both live in it.

import { launchHeadless } from "../../lib/headless.mjs";

export async function launchChrome() {
  const chrome = await launchHeadless({
    ...(process.env.KOS_EVAL_CHROME ? { binary: process.env.KOS_EVAL_CHROME } : {}),
    args: ["--enable-unsafe-extension-debugging", "--hide-scrollbars", "--window-size=1280,800"],
    prefix: "kos-eval-chrome-",
  });
  const ws = new WebSocket(chrome.wsUrl);
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
  /** Chrome stopped and waited for, then its profile deleted. */
  const close = async () => {
    try {
      ws.close();
    } catch {
      /* closed */
    }
    await chrome.close();
  };
  return { send, open, evaluate, close };
}
