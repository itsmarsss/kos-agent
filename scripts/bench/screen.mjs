#!/usr/bin/env node
// How fast KOS works on a screen, in a tab, and through a long document.
//
//   node scripts/bench/screen.mjs --kos http://127.0.0.1:4417 --workspace <ws> --label main \
//     [--tasks computer10,computer20,watch,chrome,context] [--ext packages/browser-extension/dist] [--out bench-out]
//   node scripts/bench/screen.mjs --compare bench-out/main.json bench-out/branch.json
//
// Point it at a scratch KOS, never the owner's: it pairs a fake computer
// ("Bench Mac") and a headless Chrome with it, starts chats and approves what
// they ask. See scripts/bench/README.md.

import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { nonce, rawPublicKey, signText } = await import(join(ROOT, "packages/computer/dist/keys.js"));
const { PROTOCOL_VERSION, SOCKET_PATH, deviceProof } = await import(join(ROOT, "packages/computer/dist/protocol.js"));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]] : acc), []));
const CHROME = args.chrome ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.compare) {
  const [a, b] = [args.compare, process.argv.at(-1)].map((p) => JSON.parse(readFileSync(p, "utf8")));
  console.log(compare(a, b));
  process.exit(0);
}

const KOS = args.kos ?? "http://127.0.0.1:4417";
const WORKSPACE = args.workspace;
const LABEL = args.label ?? "run";
const OUT = resolve(args.out ?? "bench-out");
const TASKS = (args.tasks ?? "computer10,computer20,watch,chrome,context").split(",");
const W = 1024;
const H = 640;
if (!WORKSPACE) throw new Error("--workspace is the scratch KOS's workspace folder (for the PDF and the SDK's logs)");
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- pages

const article = (n) => {
  const facts = { 4: "The Lisbon office opened in March with 42 staff and handles all EU support.", 9: "Q3 churn was 3.8 percent, down from 5.1 percent in Q2.", 12: "Section 12 covers the warehouse move: the Leeds site closes in June and stock moves to Doncaster over six weeks." };
  const filler = (i) => Array.from({ length: 9 }, (_, j) => `Paragraph ${j + 1} of section ${i} reviews routine operating detail: staffing levels, supplier terms, delivery windows and the quarterly targets each team agreed, with no change from the plan.`).join(" ");
  return `<!doctype html><meta charset=utf-8><title>Annual operations review</title><style>body{font:15px Georgia;max-width:680px;margin:40px auto}section{page-break-after:always}</style><h1>Annual operations review</h1>${Array.from({ length: n }, (_, i) => `<section><h2>Section ${i + 1}</h2><p>${facts[i + 1] ?? ""} ${filler(i + 1)}</p></section>`).join("")}`;
};
const wizard = (n) => `<!doctype html><meta charset=utf-8><title>Bench Desk</title>
<style>body{margin:0;width:${W}px;height:${H}px;font:20px -apple-system,Helvetica;background:#eef1f6}main{margin:60px auto;width:620px;background:#fff;border-radius:14px;padding:30px 36px;box-shadow:0 2px 12px #0002}code{font-size:34px;letter-spacing:4px;background:#f3f0e6;padding:4px 12px;border-radius:6px}input{font-size:22px;padding:10px;width:240px}button{font-size:20px;padding:10px 26px;margin-left:12px}#msg{color:#b00;height:26px}</style>
<main><h2>Setup wizard</h2><p id=step></p><p>Code: <code id=code></code></p><p><input id=box placeholder="Type the code"><button id=next>Next</button></p><p id=msg></p></main>
<script>const N=${n};let i=1;const words="AMBER,BISON,CEDAR,DELTA,EMBER,FJORD,GLINT,HAZEL,IVORY,JUMBO,KAYAK,LUNAR,MAPLE,NOVA,OPAL,PIXEL,QUILL,RAVEN,SOLAR,TULIP,UMBRA,VIVID".split(",");
const show=()=>{if(i>N){document.querySelector('main').innerHTML='<h2>All done.</h2><p>Final code: <code>'+words[N%words.length]+'-'+N+'</code></p>';window.benchDone=true;return;}step.textContent='Step '+i+' of '+N;code.textContent=words[(i-1)%words.length];box.value='';msg.textContent='';};
next.onclick=()=>{if(box.value.trim().toUpperCase()===words[(i-1)%words.length]){i++;show();}else msg.textContent='That is not the code shown.';};
box.onkeydown=(e)=>{if(e.key==='Enter')next.click();};show();</script>`;
const watch = (secs) => `<!doctype html><meta charset=utf-8><title>Bench Desk</title>
<style>body{margin:0;width:${W}px;height:${H}px;font:22px -apple-system,Helvetica;background:#eef1f6}main{margin:120px auto;width:560px;background:#fff;border-radius:14px;padding:34px;box-shadow:0 2px 12px #0002}</style>
<main><h2>Export</h2><p id=s>Starting…</p></main><script>const t0=Date.now();const tick=()=>{const p=Math.min(100,Math.round((Date.now()-t0)/(${secs}*10)));if(p<100){s.textContent='Export running… '+p+'%';setTimeout(tick,500);}else{s.textContent='Export finished: 1,284 rows written.';window.benchDone=true;}};tick();</script>`;
const shopPage = `<!doctype html><meta charset=utf-8><title>Field Goods · Stoneware Mug</title><h1>Stoneware Mug, 12 oz</h1><p>Price: <b>$16</b>. Ships in 2 days.</p><button id="add" onclick="this.textContent='Added to cart'" style="padding:14px 22px">Add to cart</button>`;
const stepsPage = `<!doctype html><meta charset=utf-8><title>Steps</title><h1 id="h">Step 0</h1>${[1, 2, 3, 4, 5].map((n) => `<button onclick="if (document.getElementById('h').textContent === 'Step ${n - 1}') document.getElementById('h').textContent = 'Step ${n}'" style="margin:8px;padding:12px 18px">Next ${n}</button>`).join("")}`;

const site = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const html = u.pathname === "/wizard" ? wizard(Number(u.searchParams.get("n") ?? 10)) : u.pathname === "/watch" ? watch(Number(u.searchParams.get("s") ?? 40)) : u.pathname === "/steps" ? stepsPage : u.pathname === "/article" ? article(30) : shopPage;
  res.writeHead(200, { "content-type": "text/html" }).end(html);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// ---------------------------------------------------------------- Chrome over CDP

const dbg = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${dbg}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "kos-bench-"))}`, "--enable-unsafe-extension-debugging", "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
let ver;
for (let i = 0; i < 300 && !ver; i++) {
  ver = await fetch(`http://127.0.0.1:${dbg}/json/version`).then((r) => r.json()).catch(() => undefined);
  if (!ver) await sleep(100);
}
const cdp = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let seq = 0;
const waiting = new Map();
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) waiting.get(m.id)?.(m);
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const k = ++seq;
    waiting.set(k, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result ?? {})));
    cdp.send(JSON.stringify({ id: k, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const open = async (url) => {
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, session: sessionId };
};
const evaluate = async (session, expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session)).result?.value;

// ---------------------------------------------------------------- KOS

const api = async (path, body) => {
  const r = await fetch(`${KOS}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
};
/** The owner, at the dashboard: approves whatever a bench chat asks. */
const approveAll = async () => {
  const pending = await api("/api/approvals").catch(() => []);
  for (const a of Array.isArray(pending) ? pending : []) await api("/api/approve", { id: a.id }).catch(() => undefined);
};
/** Says something in a chat and waits for the turn to finish; the wall time. */
const turn = async (sessionId, text, limitMs = 600_000) => {
  const t0 = Date.now();
  void api("/api/message", { sessionId, text }).catch(() => undefined);
  let worked = false;
  while (Date.now() - t0 < limitMs) {
    await approveAll();
    const c = (await api("/api/conversations")).find((x) => x.id === sessionId);
    if (c?.activity === "working") worked = true;
    else if (worked) break;
    await sleep(400);
  }
  const messages = await api(`/api/conversations/${encodeURIComponent(sessionId)}/messages`).catch(() => []);
  const said = (Array.isArray(messages) ? messages : messages.messages ?? []).filter((m) => m.role === "assistant" || m.role === "kos").at(-1);
  const answer = typeof said?.text === "string" ? said.text : JSON.stringify(said?.content ?? "").slice(0, 400);
  return { t0, t1: Date.now(), wall: (Date.now() - t0) / 1000, answer };
};
const newChat = async (title) => (await api("/api/conversations/new", { title })).id;

// ---------------------------------------------------------------- the SDK's own record of each model call

const sdkDir = join(homedir(), ".claude", "projects", resolve(WORKSPACE).replace(/[^A-Za-z0-9]/g, "-"));
/** Every model call the SDK made between t0 and t1: when it was asked, how long it took, the tokens. */
function sdkCalls(t0, t1) {
  if (!existsSync(sdkDir)) return [];
  const lines = [];
  for (const f of readdirSync(sdkDir)) {
    if (!f.endsWith(".jsonl") || statSync(join(sdkDir, f)).mtimeMs < t0) continue;
    for (const raw of readFileSync(join(sdkDir, f), "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        const j = JSON.parse(raw);
        const at = Date.parse(j.timestamp ?? "");
        if (at >= t0 - 1000 && at <= t1 + 2000) lines.push({ ...j, at, file: f });
      } catch {
        /* a line still being written */
      }
    }
  }
  lines.sort((a, b) => a.at - b.at);
  const calls = new Map();
  let lastInput = t0;
  for (const l of lines) {
    if (l.type === "assistant" && l.message?.id) {
      const u = l.message.usage ?? {};
      const prev = calls.get(l.message.id);
      calls.set(l.message.id, {
        model: l.message.model,
        sidechain: l.isSidechain === true,
        asked: prev?.asked ?? lastInput,
        answered: l.at,
        input: u.input_tokens ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
        written: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        tools: [...(prev?.tools ?? []), ...(l.message.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name.replace(/^mcp__kos__/, ""))],
      });
    } else if (l.type === "user") lastInput = l.at;
  }
  const out = [...calls.values()].sort((a, b) => a.asked - b.asked);
  // Tool time: from a call's answer to the next call's question (the tool ran in between).
  return out.map((c, i) => ({ ...c, modelMs: c.answered - c.asked, toolMs: i + 1 < out.length ? Math.max(0, out[i + 1].asked - c.answered) : 0 }));
}

// ---------------------------------------------------------------- a fake KOS for Mac, whose screen is a real page

async function fakeMac() {
  const key = generateKeyPairSync("ed25519").privateKey;
  const { code } = await api("/api/devices/pairings", {});
  const paired = await api("/api/devices/pair", { code, name: "Bench Mac", platform: "macos", publicKey: rawPublicKey(key) });
  const id = paired.device ?? paired.id;
  const screen = await open("about:blank");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, screen.session);
  const mine = nonce();
  const calls = [];
  const ws = new WebSocket(`${KOS.replace(/^http/, "ws")}${SOCKET_PATH}`);
  const mouse = async (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra }, screen.session);
  const KEYS = { return: ["Enter", 13], enter: ["Enter", 13], tab: ["Tab", 9], escape: ["Escape", 27], backspace: ["Backspace", 8], space: [" ", 32] };
  const handle = async (method, p) => {
    switch (method) {
      case "session.begin":
        return { granted: true, until: Date.now() + 30 * 60_000, space: { width: W, height: H } };
      case "screen.capture": {
        const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, screen.session);
        return { image: data, mediaType: "image/jpeg", width: W, height: H, cursor: { x: 0, y: 0 }, app: { name: "Bench Desk", bundle: "dev.kos.bench" } };
      }
      case "pointer.click":
        for (let n = 1; n <= (p.count ?? 1); n++) {
          await mouse("mousePressed", p.x, p.y, { clickCount: n });
          await mouse("mouseReleased", p.x, p.y, { clickCount: n });
        }
        return { cursor: { x: p.x, y: p.y } };
      case "pointer.move":
        await mouse("mouseMoved", p.x, p.y);
        return { cursor: { x: p.x, y: p.y } };
      case "pointer.scroll":
        await mouse("mouseWheel", p.x, p.y, { deltaX: (p.dx ?? 0) * 40, deltaY: (p.dy ?? 0) * 40 });
        return { cursor: { x: p.x, y: p.y } };
      case "keys.type":
        await send("Input.insertText", { text: p.text }, screen.session);
        return {};
      case "keys.press": {
        const k = KEYS[String(p.keys).toLowerCase()];
        if (k) for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k[0], code: k[0], windowsVirtualKeyCode: k[1], ...(type === "keyDown" && k[0] === "Enter" ? { text: "\r" } : {}) }, screen.session);
        return {};
      }
      default:
        return {};
    }
  };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "challenge") {
      ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, device: id, nonce: mine, signature: signText(key, deviceProof(m.nonce, id)), app: { version: "0.1.0", platform: "macos", os: "26.4" }, consent: "device", permissions: { screen: true, input: true }, displays: [{ id: 1, width: W, height: H, scale: 1, main: true }] }));
    } else if (m.t === "call") {
      const t = Date.now();
      try {
        const result = await handle(m.method, m.params ?? {});
        ws.send(JSON.stringify({ t: "reply", id: m.id, ok: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ t: "reply", id: m.id, ok: false, error: { code: "internal", message: String(err) } }));
      }
      calls.push({ method: m.method, at: t, ms: Date.now() - t });
    }
  };
  await new Promise((r) => (ws.onopen = r));
  for (let i = 0; i < 50; i++) {
    const d = (await api("/api/devices")).devices?.find((x) => x.id === id);
    if (d?.online) break;
    await sleep(200);
  }
  return {
    calls,
    show: async (url) => {
      await send("Page.navigate", { url }, screen.session);
      await sleep(600);
    },
    done: () => evaluate(screen.session, "window.benchDone === true"),
    close: async () => {
      ws.close();
      await api("/api/devices/remove", { id }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------- the tasks

const results = [];
const record = (name, run, ok, extra = {}) => {
  const calls = sdkCalls(run.t0, run.t1);
  const r = { name, ok, wall: run.wall, answer: String(run.answer ?? "").slice(0, 300), calls, ...extra };
  results.push(r);
  log(LABEL, name, ok ? "ok" : "FAILED", `${run.wall.toFixed(1)} s`, `${calls.length} model calls`, "->", r.answer.slice(0, 90).replace(/\s+/g, " "));
  writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify({ label: LABEL, at: new Date().toISOString(), results }, null, 1));
};

if (TASKS.some((t) => t.startsWith("computer") || t === "watch")) {
  const mac = await fakeMac();
  for (const [name, n] of [["computer10", 10], ["computer20", 20]]) {
    if (!TASKS.includes(name)) continue;
    await mac.show(`${SITE}/wizard?n=${n}`);
    const chat = await newChat(`bench ${name}`);
    const run = await turn(chat, "On Bench Mac, the Bench Desk app is in front with a setup wizard. Finish it: each step shows a code; type that code into the box and press Next. When it says All done, end the session and tell me the final code.");
    const done = await mac.done();
    record(name, run, done && run.answer.includes(`-${n}`), { device: mac.calls.splice(0) });
  }
  if (TASKS.includes("watch")) {
    await mac.show(`${SITE}/watch?s=45`);
    const chat = await newChat("bench watch");
    const run = await turn(chat, "On Bench Mac, an export is running in the Bench Desk app in front. Watch it until it finishes, then end the session and tell me how many rows it wrote.");
    record("watch", run, /1,?284/.test(run.answer), { device: mac.calls.splice(0) });
  }
  await mac.close();
}

if (TASKS.includes("chrome")) {
  const ext = join(OUT, "ext");
  cpSync(resolve(args.ext ?? join(ROOT, "packages/browser-extension/dist")), ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));
  const { id } = await send("Extensions.loadUnpacked", { path: ext });
  const popup = await open(`chrome-extension://${id}/popup.html`);
  await sleep(800);
  const { code } = await api("/api/devices/pairings", {});
  const link = `kos-device://pair?url=${encodeURIComponent(KOS)}&code=${code}`;
  await evaluate(popup.session, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "Bench Chrome" })`);
  await sleep(1500);
  await open(`${SITE}/mug`);
  await sleep(1500);
  await send("Runtime.evaluate", { expression: `(async () => { const all = await chrome.windows.getAll({ populate: true }); const w = all.find((x) => x.tabs.some((t) => (t.url || "").includes("/mug"))); await chrome.sidePanel.open({ windowId: w.id }); })()`, awaitPromise: true, userGesture: true }, popup.session);
  let panel;
  for (let i = 0; i < 100 && !panel; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const t = targetInfos.find((x) => x.url.endsWith("/panel.html"));
    if (t) panel = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
    else await sleep(100);
  }
  const q = (expr) => evaluate(panel, expr);
  await sleep(4000);
  await q("document.querySelector('.chat-title')?.click()");
  await sleep(600);
  await q("document.querySelector('.switcher-new')?.click()");
  await sleep(3500);
  if ((await q("document.querySelector('.mode')?.getAttribute('aria-pressed')")) !== "true") await q("document.querySelector('.mode')?.click()");
  await sleep(1000);
  const say = (text) => q(`(() => { const ta = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => document.querySelector('.send').click(), 50); })()`);
  const tasks = [
    ["chrome-price", "Tell me the price on this page.", /16/],
    ["chrome-cart", "Click Add to cart, then tell me what the button says.", /added to cart/i],
    ["chrome-steps", `Open ${SITE}/steps in this Chrome, click Next 1, then Next 2, Next 3, Next 4 and Next 5 in order, one click per step and looking at the page after each, then tell me the heading.`, /step 5/i],
  ];
  for (const [name, text, expect] of tasks) {
    const t0 = Date.now();
    await say(text);
    let chat;
    let worked = false;
    while (Date.now() - t0 < 600_000) {
      if (await q("!!document.querySelector('.ask-card--consent')")) await q("document.querySelector('.ask-card--consent .btn--primary').click()");
      if (await q("!!document.querySelector('.ask-card:not(.ask-card--consent) .btn--primary')")) await q("document.querySelector('.ask-card:not(.ask-card--consent) .btn--primary').click()");
      const list = await api("/api/conversations");
      const c = chat ? list.find((x) => x.id === chat) : list.filter((x) => x.channel === "chrome").sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      if (c && !chat && (c.updatedAt ?? 0) >= t0 - 2000) chat = c.id;
      if (c?.activity === "working") worked = true;
      if (chat && worked && c?.activity !== "working") break;
      await sleep(300);
    }
    await sleep(800);
    const answer = await q("[...document.querySelectorAll('.msg--kos')].at(-1)?.textContent.trim() ?? ''");
    const run = { t0, t1: Date.now(), wall: (Date.now() - t0) / 1000, answer };
    record(name, run, expect.test(answer));
    await sleep(1500);
  }
}

if (TASKS.includes("context")) {
  // The same 30-section review, as a PDF in the workspace.
  const page = await open(`${SITE}/article`);
  await sleep(800);
  const { data } = await send("Page.printToPDF", { printBackground: false }, page.session);
  mkdirSync(join(WORKSPACE, "bench"), { recursive: true });
  writeFileSync(join(WORKSPACE, "bench", "review.pdf"), Buffer.from(data, "base64"));
  const chat = await newChat("bench context");
  const turns = [
    ["context-read", "Read bench/review.pdf in the workspace and tell me, in one line, what it is.", /review|operations/i],
    ["context-lisbon", "What does it say about the Lisbon office?", /42/],
    ["context-churn", "What was Q3 churn?", /3\.8/],
    ["context-s12", "Summarize section 12 in one sentence.", /Leeds|Doncaster/i],
  ];
  for (const [name, text, expect] of turns) {
    const run = await turn(chat, text);
    record(name, run, expect.test(run.answer));
  }
}

// Screen work late in a long chat, where the owner's slow steps were: about 70k tokens of history first.
if (TASKS.includes("heavy")) {
  const mac = await fakeMac();
  await mac.show(`${SITE}/wizard?n=10`);
  const heavy = await newChat("bench heavy");
  const notes = Array.from({ length: 2400 }, (_, i) => `Note ${i + 1}: met the supplier about the autumn range, agreed the delivery window and the unit price, nothing to act on.`).join("\n");
  await turn(heavy, `Here are my notes from this month, for later. Just say OK.\n\n${notes}`);
  const run = await turn(heavy, "On Bench Mac, the Bench Desk app is in front with a setup wizard. Finish it: each step shows a code; type that code into the box and press Next. When it says All done, end the session and tell me the final code.");
  record("heavy10", run, (await mac.done()) && run.answer.includes("-10"), { device: mac.calls.splice(0) });
  await mac.close();
}

writeFileSync(join(OUT, `${LABEL}.md`), table({ label: LABEL, results }));
log("wrote", join(OUT, `${LABEL}.json`), "and", `${LABEL}.md`);
cdp.close();
chrome.kill();
site.close();
process.exit(0);

// ---------------------------------------------------------------- tables

function summary(r) {
  const calls = r.calls ?? [];
  const sum = (f) => calls.reduce((n, c) => n + f(c), 0);
  const ms = calls.map((c) => c.modelMs).sort((a, b) => a - b);
  return {
    wall: r.wall,
    ok: r.ok,
    calls: calls.length,
    model: sum((c) => c.modelMs) / 1000,
    tool: sum((c) => c.toolMs) / 1000,
    medianModel: ms.length ? ms[Math.floor(ms.length / 2)] / 1000 : 0,
    maxInput: Math.max(0, ...calls.map((c) => c.input + c.cached + c.written)),
    input: sum((c) => c.input + c.written),
    cached: sum((c) => c.cached),
    output: sum((c) => c.output),
  };
}
function table(run) {
  const rows = run.results.map((r) => {
    const s = summary(r);
    return `| ${r.name} | ${s.ok ? "yes" : "no"} | ${s.wall.toFixed(1)} | ${s.calls} | ${s.model.toFixed(1)} | ${s.tool.toFixed(1)} | ${s.medianModel.toFixed(1)} | ${s.maxInput} | ${s.input} | ${s.cached} | ${s.output} |`;
  });
  return [`### ${run.label}`, "", "| Task | Done | Wall s | Model calls | Model s | Tool s | Median call s | Largest prompt | Uncached in | Cached in | Out |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}
function compare(a, b) {
  const names = [...new Set([...a.results, ...b.results].map((r) => r.name))];
  const rows = names.map((n) => {
    const [x, y] = [a, b].map((run) => run.results.find((r) => r.name === n));
    const [sx, sy] = [x, y].map((r) => (r ? summary(r) : undefined));
    const cell = (s) => (s ? `${s.wall.toFixed(1)} s, ${s.calls} calls, ${Math.round(s.maxInput / 1000)}k peak${s.ok ? "" : ", FAILED"}` : "not run");
    return `| ${n} | ${cell(sx)} | ${cell(sy)} |`;
  });
  return [`| Task | ${a.label} | ${b.label} |`, "| --- | --- | --- |", ...rows].join("\n");
}
