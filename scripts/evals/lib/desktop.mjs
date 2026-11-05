// A fake KOS for Mac that pairs with the real handshake and whose screen is fixtures/desktop.html:
// a desktop of apps in windows, so KOS has to look, find and click as it would on a real Mac.
// It keeps KOS for Mac's own rules: hidden apps are drawn black and cannot be a session's target.

import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fakeMac({ root, kos, chrome, deskUrl, hidden = ["1Password"], setup = {} }) {
  const { nonce, rawPublicKey, signText } = await import(join(root, "packages/computer/dist/keys.js"));
  const { PROTOCOL_VERSION, SOCKET_PATH, deviceProof } = await import(join(root, "packages/computer/dist/protocol.js"));
  const key = generateKeyPairSync("ed25519").privateKey;
  const { code } = await kos.api("/api/devices/pairings", {});
  const paired = await kos.api("/api/devices/pair", { code, name: "Eval Mac", platform: "macos", publicKey: rawPublicKey(key) });
  const id = paired.device ?? paired.id;
  const screen = await chrome.open("about:blank");
  const size = { w: 1280, h: 800 };
  const metrics = () => chrome.send("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false }, screen.session);
  await metrics();
  await chrome.send("Page.navigate", { url: deskUrl }, screen.session);
  await sleep(800);
  const desk = (expr) => chrome.evaluate(screen.session, expr);
  await desk(`desk.setup(${JSON.stringify(setup)})`);
  const calls = [];
  const sessions = [];
  const mouse = (type, x, y, extra = {}) => chrome.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra }, screen.session);
  const KEYS = { return: ["Enter", 13, "\r"], enter: ["Enter", 13, "\r"], tab: ["Tab", 9], escape: ["Escape", 27], esc: ["Escape", 27], backspace: ["Backspace", 8], delete: ["Delete", 46], space: [" ", 32, " "], up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39], home: ["Home", 36], end: ["End", 35] };
  const press = async (combo) => {
    const c = String(combo).toLowerCase().replace(/\s+/g, "");
    if (/^(cmd|command|meta)\+[a-z]$/.test(c) && (await desk(`desk.key(${JSON.stringify(c.replace(/^(command|meta)/, "cmd"))})`))) return;
    const k = KEYS[c.split("+").at(-1)];
    if (!k) return;
    for (const type of ["keyDown", "keyUp"]) await chrome.send("Input.dispatchKeyEvent", { type, key: k[0], code: k[0], windowsVirtualKeyCode: k[1], ...(type === "keyDown" && k[2] ? { text: k[2] } : {}) }, screen.session);
  };
  const handle = async (method, p) => {
    switch (method) {
      case "session.begin": {
        const app = p.target?.app;
        if (app && hidden.some((h) => h.toLowerCase() === String(app).toLowerCase())) throw Object.assign(new Error(`${app} is hidden from KOS on this Mac`), { code: "hidden_app" });
        size.w = typeof p.maxEdge === "number" ? p.maxEdge : 1280;
        size.h = Math.round(size.w * 0.625);
        await metrics();
        if (app) await desk(`desk.setup({ front: ${JSON.stringify(app)} })`);
        sessions.push({ task: p.task, app: app ?? null, at: Date.now() });
        return { granted: true, until: Date.now() + 30 * 60_000, space: { width: size.w, height: size.h }, target: { kind: "screen" } };
      }
      case "screen.capture": {
        await desk(`desk.blank(${JSON.stringify(hidden)}, true)`);
        const clip = p.region ? { x: p.region.x, y: p.region.y, width: p.region.width, height: p.region.height, scale: 1 } : undefined;
        const { data } = await chrome.send("Page.captureScreenshot", { format: "jpeg", quality: 80, ...(clip ? { clip } : {}) }, screen.session);
        await desk(`desk.blank(${JSON.stringify(hidden)}, false)`);
        const front = await desk("desk.frontApp()");
        const shown = hidden.includes(front) ? { name: "hidden" } : { name: front, bundle: `dev.kos.eval.${String(front).toLowerCase()}` };
        return { image: data, mediaType: "image/jpeg", width: clip ? clip.width : size.w, height: clip ? clip.height : size.h, cursor: { x: 0, y: 0 }, app: shown };
      }
      case "pointer.click":
        for (let n = 1; n <= (p.count ?? 1); n++) {
          await mouse("mousePressed", p.x, p.y, { clickCount: n, button: p.button ?? "left" });
          await mouse("mouseReleased", p.x, p.y, { clickCount: n, button: p.button ?? "left" });
        }
        return { cursor: { x: p.x, y: p.y } };
      case "pointer.move":
        await mouse("mouseMoved", p.x, p.y);
        return { cursor: { x: p.x, y: p.y } };
      case "pointer.drag":
        await mouse("mousePressed", p.from.x, p.from.y);
        await mouse("mouseMoved", p.to.x, p.to.y);
        await mouse("mouseReleased", p.to.x, p.to.y);
        return { cursor: p.to };
      case "pointer.scroll":
        await mouse("mouseWheel", p.x, p.y, { deltaX: (p.dx ?? 0) * 40, deltaY: (p.dy ?? 0) * 40 });
        return { cursor: { x: p.x, y: p.y } };
      case "keys.type":
        await chrome.send("Input.insertText", { text: p.text }, screen.session);
        return {};
      case "keys.press":
        for (let i = 0; i < Math.max(1, p.repeat ?? 1); i++) await press(p.keys);
        return {};
      case "session.end":
        return {};
      default:
        return {};
    }
  };
  const ws = new WebSocket(`${kos.url.replace(/^http/, "ws")}${SOCKET_PATH}`);
  const mine = nonce();
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "challenge") {
      ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, device: id, nonce: mine, signature: signText(key, deviceProof(m.nonce, id)), app: { version: "0.1.0", platform: "macos", os: "26.4" }, consent: "device", permissions: { screen: true, input: true }, displays: [{ id: 1, width: 1280, height: 800, scale: 1, main: true }] }));
    } else if (m.t === "call") {
      const t = Date.now();
      try {
        const result = await handle(m.method, m.params ?? {});
        ws.send(JSON.stringify({ t: "reply", id: m.id, ok: true, result }));
        calls.push({ method: m.method, at: t, ms: Date.now() - t, ok: true });
      } catch (err) {
        ws.send(JSON.stringify({ t: "reply", id: m.id, ok: false, error: { code: err.code ?? "internal", message: String(err.message ?? err) } }));
        calls.push({ method: m.method, at: t, ms: Date.now() - t, ok: false, error: err.code ?? "internal" });
      }
    }
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error("fake Mac could not reach KOS"));
  });
  for (let i = 0; i < 50; i++) {
    const d = (await kos.api("/api/devices")).devices?.find((x) => x.id === id);
    if (d?.online) break;
    await sleep(200);
  }
  return {
    id,
    calls,
    sessions,
    state: () => desk("desk.state()"),
    desk,
    close: async () => {
      ws.close();
      await kos.api("/api/devices/remove", { id }).catch(() => undefined);
    },
  };
}
