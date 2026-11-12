// The device updates end to end, against a scratch KOS that e2e.sh started: KOS for Chrome, the real one in
// a Chrome for Testing of its own, loaded unpacked as the owner loads it, connects on an older build and
// reloads itself into the one in its folder; a stand-in for
// KOS for Mac connects behind while a turn runs in its chat, and the installer (a stub here) runs once, when the
// turn is over; both come back up to date, and every step is in the audit log.
//
//   node updates.mjs   (every input from the environment e2e.sh sets)
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WebSocket } from "ws";

import { sourceBuild } from "../../dist/builds.js";
import { hereProof } from "../../dist/keys.js";

const env = (name) => process.env[name] ?? fail(`${name} is not set`);
const DASH = env("KOS_E2E_DASHBOARD");
const WS = env("KOS_E2E_WORKSPACE");
const ROOT = env("KOS_E2E_ROOT");
const DIR = env("KOS_E2E_DIR");
const CHROME = env("KOS_E2E_CHROME");
const CDP_PORT = Number(env("KOS_E2E_CDP_PORT"));
const INSTALLS = join(DIR, "installs.log");
const SHOTS = process.env.KOS_E2E_SHOTS;

function fail(why) {
  console.error(`e2e: ${why}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, test, ms = 30_000, last = async () => "") {
  const end = Date.now() + ms;
  for (;;) {
    const got = await test();
    if (got) return got;
    if (Date.now() > end) fail(`timed out waiting for ${what} ${await last()}`.trim());
    await sleep(200);
  }
}
const say = (line) => console.log(`e2e: ${line}`);

async function api(path, body) {
  const res = await fetch(`${DASH}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) fail(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
}
const device = async (id) => (await api("/api/devices")).devices.find((d) => d.id === id);
const audits = () => {
  const out = execFileSync("sqlite3", ["-json", join(WS, "kos.sqlite"), "select args from audit_log where tool = 'device.update' order by id"], { encoding: "utf8" }).trim();
  return (out ? JSON.parse(out) : []).map((row) => JSON.parse(row.args));
};
const installs = () => {
  try {
    return readFileSync(INSTALLS, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

const OLD = { id: "000000000001", commit: "", builtAt: Date.now() - 86_400_000 };
const chromeNew = JSON.parse(readFileSync(join(ROOT, "packages/browser-extension/dist/build.json"), "utf8"));
const macNew = sourceBuild(ROOT, "mac") ?? fail("no KOS for Mac sources to build");

// KOS for Mac, played: paired with a code, proved with its own key, answering every chat call as the window would.
class StubMac {
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.key = privateKey;
    this.publicKey = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    this.updates = [];
  }

  async pair() {
    const { code } = await api("/api/devices/pairings", {});
    this.id = (await api("/api/devices/pair", { code, name: "E2E Mac", platform: "macos", publicKey: this.publicKey })).device;
  }

  /** A line opened with the build it says it runs; resolves once KOS welcomed it. */
  connect(build) {
    this.ws?.close();
    const ws = new WebSocket(`${DASH.replace(/^http/, "ws")}/api/devices/socket`);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (data) => {
        const m = JSON.parse(String(data));
        if (m.t === "challenge") {
          const signature = sign(null, Buffer.from(`kos-device/1|device|${m.nonce}|${this.id}`), this.key).toString("base64");
          // On KOS's computer: it reads the secret KOS keeps there, as KOS for Mac does, and proves it.
          const here = hereProof(Buffer.from(readFileSync(join(DIR, "device-local.key"), "utf8").trim(), "base64"), m.nonce, this.id);
          ws.send(JSON.stringify({
            t: "hello", protocol: 1, device: this.id, nonce: randomBytes(32).toString("base64"), signature,
            app: { version: "0.1.0", platform: "macos", os: "26.1.0" }, ...(build ? { build } : {}), here,
            consent: "device", permissions: { screen: true, input: true }, displays: [{ id: 1, width: 1512, height: 982, scale: 2, main: true }],
          }));
        } else if (m.t === "welcome") resolve();
        else if (m.t === "update") this.updates.push(m);
        else if (m.t === "call") ws.send(JSON.stringify({ t: "reply", id: m.id, ok: true, result: {} }));
      });
    });
  }

  event(name, data) {
    this.ws.send(JSON.stringify({ t: "event", name, data }));
  }
}

// A DevTools line to the test's own Chrome.
class Devtools {
  static async open(port) {
    const version = await until("the test Chrome", () => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => undefined));
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => ws.once("open", r));
    return new Devtools(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.waiting = new Map();
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (typeof m.id === "number") this.waiting.get(m.id)?.(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result ?? {})));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async page(url) {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await until(`${url} to load`, async () => (await this.evaluate(sessionId, "document.readyState").catch(() => "")) === "complete");
    return sessionId;
  }
  async evaluate(sessionId, expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

/** The dashboard's Devices settings in each theme, as PNGs, to look at. */
async function shoot(devtools, name) {
  if (!SHOTS) return;
  const page = await devtools.page(`${DASH}/#/settings/devices`);
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1500, deviceScaleFactor: 1, mobile: false }, page);
  for (const theme of ["dark", "light"]) {
    await devtools.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, page);
    await until("the Devices panel", async () => (await devtools.evaluate(page, "!!document.querySelector('.set-hint--open')").catch(() => false)));
    await sleep(600);
    const { data } = await devtools.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, page);
    writeFileSync(join(SHOTS, `${name}-${theme}.png`), Buffer.from(data, "base64"));
  }
}

say(`KOS's builds: Chrome ${chromeNew.id}, Mac ${macNew.id}`);

// KOS for Mac: connected on KOS's build, a turn begun in its chat, then back on an older build while it runs.
const mac = new StubMac();
await mac.pair();
await mac.connect(macNew);
await until("the Mac to be up to date", async () => (await device(mac.id))?.update?.state === "current");
mac.event("chat.send", { text: "take your time with this", beside: { kind: "none" } });
await sleep(1_000);
await mac.connect(OLD);
const waiting = await until("the Mac to wait for an idle window", async () => {
  const d = await device(mac.id);
  return d?.update?.state === "behind" && d.update.reason === "idle" ? d : undefined;
});
if (installs() !== 0) fail("the installer ran while a turn was running");
say(`the Mac is behind (${waiting.build.id}) and waits: ${JSON.stringify(waiting.update)}`);

// KOS for Chrome: the real extension, loaded unpacked from a folder of its own stamped with an older build.
// --load-extension, which Chrome for Testing still takes, is the owner's Load unpacked: the extension stays
// when it reloads. One loaded over DevTools (Extensions.loadUnpacked) is gone at its first reload, and without
// --enable-unsafe-extension-debugging Chrome turns it off then as an unsupported developer extension.
const ext = join(DIR, "ext");
cpSync(join(ROOT, "packages/browser-extension/dist"), ext, { recursive: true });
writeFileSync(join(ext, "build.json"), JSON.stringify(OLD));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(DIR, "chrome")}`, `--load-extension=${ext}`, "--enable-unsafe-extension-debugging", "--no-first-run", "about:blank"], { stdio: "ignore" });
process.on("exit", () => chrome.kill());
const devtools = await Devtools.open(CDP_PORT);
const extension = await until("the extension to load", async () =>
  (await devtools.send("Target.getTargets")).targetInfos.map((t) => t.url).find((u) => u.startsWith("chrome-extension://") && u.endsWith("/worker.js"))?.split("/")[2]);
const popup = await devtools.page(`chrome-extension://${extension}/popup.html`);
await until("the extension's worker", async () => (await devtools.evaluate(popup, "chrome.runtime.sendMessage({ type: 'state' }).then(() => true)").catch(() => false)));
// The folder rebuilt under the running extension, as a deploy does: it runs the old build until it reloads.
writeFileSync(join(ext, "build.json"), JSON.stringify(chromeNew));
const { code } = await api("/api/devices/pairings", {});
const link = `kos-device://pair?url=${encodeURIComponent(DASH)}&code=${code}`;
const paired = await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "E2E Chrome" })`);
if (!paired?.ok) fail(`the extension did not pair: ${JSON.stringify(paired)}`);
const chromeId = await until("the Chrome to be listed", async () => (await api("/api/devices")).devices.find((d) => d.kind === "browser")?.id);
const reloaded = await until("the Chrome to reload into KOS's build", async () => {
  const d = await device(chromeId);
  return d?.online && d.build?.id === chromeNew.id && d.update?.state === "current" ? d : undefined;
}, 60_000, async () => {
  // Where KOS has it, and what Chrome says of the extension: turned off at its reload, and why.
  const manager = await devtools.page("chrome://extensions/");
  const chromeSays = await devtools
    .evaluate(manager, `chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }).then((all) => JSON.stringify(all.filter((e) => e.id === ${JSON.stringify(extension)}).map((e) => ({ state: e.state, disableReasons: e.disableReasons, runtimeErrors: e.runtimeErrors }))))`)
    .catch((e) => String(e));
  return `${JSON.stringify(await device(chromeId))}\n${chromeSays}`;
});
say(`the Chrome reloaded and is up to date on ${reloaded.build.id}`);

await shoot(devtools, "devices-mac-waiting");

// The turn ends: the installer runs once, and the Mac comes back on the new build.
await until("the installer to run once the turn ended", async () => installs() === 1, 60_000);
say("the installer ran once, after the turn");
await until("the Mac to be told it is updating", async () => mac.updates.some((u) => u.state === "updating"));
await mac.connect(macNew);
await until("the Mac to be up to date", async () => (await device(mac.id))?.update?.state === "current");
await sleep(1_500);
if (installs() !== 1) fail(`the installer ran ${installs()} times`);

await shoot(devtools, "devices-current");

const rows = audits().map((a) => `${a.kind} ${a.from ?? "-"} -> ${a.to} ${a.outcome}`);
say(`audit:\n  ${rows.join("\n  ")}`);
const want = [`mac ${OLD.id} -> ${macNew.id} installing`, `chrome ${OLD.id} -> ${chromeNew.id} reloading`, `chrome ${OLD.id} -> ${chromeNew.id} updated`, `mac ${OLD.id} -> ${macNew.id} updated`];
for (const row of want) if (!rows.includes(row)) fail(`no audit row "${row}"`);
say("passed");
process.exit(0);
