import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Kernel, SecretsRegistry, Vault, type GenerateRequest, type Inference, type ModelMessage, type ModelResponse } from "@kos/harness";
import { drawingOf, lookOf } from "@kos/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createComputerUse, type ComputerUse } from "./computeruse.js";

/**
 * A saved secret filled into the owner's Chrome from end to end: a scripted
 * turn starts a session in a Chrome running the built KOS for Chrome, paired
 * with this KOS over its own device routes and socket; visits a sign-in page
 * there; fills a login through secrets.fill (kernel, OwnerChrome, DeviceHub,
 * the device link and the extension's secret.fill); looks at the page as an
 * outline, a snapshot and its text; and tries a script on a page of no
 * credential site, which the owner's Chrome refuses (Runtime.enable is not
 * passed on). The model is told it was filled in the owner's Chrome, the use
 * is recorded with the device it went into, and nothing it read holds the
 * value. Skipped without a Chrome or a build of the extension.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "browser-extension", "dist");
const BUILT = existsSync(join(DIST, "worker.js"));

const step = (content: ModelResponse["content"], stopReason: ModelResponse["stopReason"] = "tool_use"): ModelResponse => ({ content, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

/** A sign-in page that echoes the password into its text and its title. */
const LOGIN = `<!doctype html><meta charset=utf-8><title>Sign in</title>
<label>Username <input id=user autocomplete=username></label>
<label>Password <input id=pw type=password autocomplete=current-password></label>
<p>You typed <span id=echo></span></p>
<script>document.getElementById('pw').addEventListener('input', (e) => { document.getElementById('echo').textContent = e.target.value; document.title = 'typed ' + e.target.value; });</script>`;

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** Chrome's DevTools, for the test's own hands on the browser: loading the extension and talking to its popup. */
class Devtools {
  private id = 0;
  private readonly waiting = new Map<number, (m: Record<string, unknown>) => void>();
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (typeof m["id"] === "number") this.waiting.get(m["id"])?.(m);
    };
  }
  static async open(url: string): Promise<Devtools> {
    const ws = new WebSocket(url);
    await new Promise((r) => (ws.onopen = r));
    return new Devtools(ws);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m["error"] ? reject(new Error(JSON.stringify(m["error"]))) : resolve((m["result"] as Record<string, unknown>) ?? {})));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r["exceptionDetails"]) throw new Error(JSON.stringify(r["exceptionDetails"]));
    return (r["result"] as { value?: unknown }).value;
  }
  async attach(match: (url: string) => boolean): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const { targetInfos } = (await this.send("Target.getTargets")) as { targetInfos: { targetId: string; url: string; type: string }[] };
      const found = targetInfos.find((t) => t.type === "page" && match(t.url));
      if (found) return String((await this.send("Target.attachToTarget", { targetId: found.targetId, flatten: true }))["sessionId"]);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no such page");
  }
  close(): void {
    this.ws.close();
  }
}

describe.skipIf(!CHROME || !BUILT)("a saved secret filled into the owner's Chrome, end to end", { timeout: 120_000 }, () => {
  let root = "";
  let profile = "";
  let kernel: Kernel;
  let computer: ComputerUse;
  let vault: Vault;
  let login = "";
  let site: Server;
  let other: Server;
  let kos: Server;
  let base = "";
  let otherBase = "";
  let chrome: ChildProcess;
  let devtools: Devtools;
  const password = `Pw-${randomBytes(9).toString("hex")}`;
  const requests: GenerateRequest[] = [];

  const refs = new Map<string, string>();
  const readRefs = (messages: ModelMessage[]): void => {
    for (const block of messages.flatMap((m) => m.content)) {
      if (block.type !== "tool_result") continue;
      for (const m of block.content.matchAll(/textbox "([^"]+)"[^\n]*@(e\d+)/g)) if (!refs.has(m[1]!)) refs.set(m[1]!, `@${m[2]}`);
    }
  };

  /** KOS's own device routes and socket, as its dashboard server serves them. */
  const serveKos = (req: IncomingMessage, res: ServerResponse): void => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0]!;
      const answer = await computer.routes.handle({ method: req.method ?? "GET", path, body: body ? JSON.parse(body) : undefined, headers: req.headers });
      res.writeHead(answer?.status ?? 404, { "content-type": "application/json", ...(answer?.headers ?? {}) }).end(JSON.stringify(answer?.body ?? {}));
    });
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-ownerfill-"));
    site = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end(LOGIN));
    other = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Other</title><p>Other"));
    kos = createServer(serveKos);
    kos.on("upgrade", (req, socket, head) => {
      if (!computer.upgrade(req, socket, head)) socket.destroy();
    });
    for (const s of [site, other, kos]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    base = `http://localhost:${(site.address() as AddressInfo).port}`;
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const kosBase = `http://127.0.0.1:${(kos.address() as AddressInfo).port}`;

    vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    login = vault.add({ label: "Shop login", kind: "login", values: { username: "owner", password }, use: { web: { origins: [base] } } });
    const secrets = new SecretsRegistry();
    secrets.attachVault(vault);

    const inference: Inference = {
      async generate(_task, request) {
        requests.push(JSON.parse(JSON.stringify(request)) as GenerateRequest);
        if (!request.tools?.some((t) => t.name === "secrets.fill")) return step([{ type: "text", text: "ok" }], "end_turn");
        const done = request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result").length;
        readRefs(request.messages);
        const call = (input: Record<string, unknown>, name: string): ModelResponse => step([{ type: "tool_use", id: `own-${done + 1}`, name, input }]);
        switch (done) {
          case 0:
            return call({ task: "sign in to the shop" }, "chrome.start");
          case 1:
            return call({ url: `${base}/`, wait: "load" }, "browser.visit");
          case 2:
            return call({ secret: login, fields: [{ field: "username", target: refs.get("Username") }, { field: "password", target: refs.get("Password") }], intent: "sign in" }, "secrets.fill");
          case 3:
            return call({}, "browser.look");
          case 4:
            return call({ then: "snapshot" }, "browser.look");
          case 5:
            return call({ then: "read" }, "browser.look");
          case 6:
            return call({ url: `${otherBase}/`, wait: "load" }, "browser.visit");
          case 7:
            return call({ code: "1 + 1" }, "browser.eval");
          default:
            return step([{ type: "text", text: "Signed in." }], "end_turn");
        }
      },
    };
    const panel = { current: () => undefined, events: () => [] };
    computer = createComputerUse({
      hostKeyPath: join(root, "device-host.key"),
      localKeyPath: join(root, "device-local.key"),
      caller: () => kernel.callerConversationId,
      pageSecrets: { saved: () => kernel.secrets.browserValues(), savedFor: (origins) => kernel.secrets.pageValues(origins), evalBlocked: (origin) => kernel.secrets.evalBlocked(origin) },
      titleOf: (id) => id,
      halted: () => false,
      face: () => drawingOf(lookOf("kos")),
      theme: () => ({ mode: "system" }),
      panels: { chrome: panel, mac: panel, phone: panel },
    });
    kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets, inference, profileOverrides: { name: "Kenny", timezone: "UTC" }, extraModules: [computer.module] });
    kernel.setBrowserElsewhere(computer.chrome);

    profile = mkdtempSync(join(tmpdir(), "kos-ownerfill-chrome-"));
    const port = await freePort();
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging", "--no-first-run", "--use-mock-keychain", "about:blank"], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, HOME: "/tmp" },
    });
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 300 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => undefined);
      if (!version) await new Promise((r) => setTimeout(r, 100));
    }
    devtools = await Devtools.open(version!.webSocketDebuggerUrl);
    const { id } = (await devtools.send("Extensions.loadUnpacked", { path: DIST })) as { id: string };
    await devtools.send("Target.createTarget", { url: `chrome-extension://${id}/popup.html` });
    const popup = await devtools.attach((u) => u.endsWith("/popup.html"));
    for (let i = 0; i < 50 && !(await devtools.evaluate(popup, "!!globalThis.chrome?.runtime?.id").catch(() => false)); i++) {
      await devtools.send("Page.reload", {}, popup).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
    const { code } = (await computer.routes.handle({ method: "POST", path: "/api/devices/pairings", body: {} }))!.body as { code: string };
    const link = `kos-device://pair?url=${encodeURIComponent(kosBase)}&code=${encodeURIComponent(code)}`;
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "Test Chrome" })`)).toMatchObject({ ok: true });
    const listed = async (): Promise<{ id: string; online: boolean }[]> => ((await computer.routes.handle({ method: "GET", path: "/api/devices" }))!.body as { devices: { id: string; online: boolean }[] }).devices;
    await vi.waitFor(async () => expect((await listed())[0]?.online).toBe(true), { timeout: 15_000, interval: 100 });
    // The owner's Chrome asks nothing of its own: KOS's approvals decide, as the owner does below.
    await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "askFirst", id: ${JSON.stringify((await listed())[0]!.id)}, on: false })`);
  }, 90_000);

  afterAll(async () => {
    devtools?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((r) => chrome.once("exit", r));
      try {
        process.kill(-chrome.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      await exited;
    }
    await computer?.close();
    kernel?.close();
    for (const s of [site, other, kos]) {
      s?.closeAllConnections();
      s?.close();
    }
    for (const dir of [profile, root]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("fills through KOS for Chrome, says where, records the device, and shows the model no value", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, channel: "dashboard" });
    const decided = new Set<number>();
    const approver = setInterval(() => {
      for (const ask of kernel.approvals.pending()) {
        if (decided.has(ask.id)) continue;
        decided.add(ask.id);
        void kernel.approve(ask.id, kernel.profile.ownerId, { surface: "dashboard" });
      }
    }, 50);
    await kernel.handleMessage("Sign me in at the shop in my Chrome.", { owner: true, sessionId: chat.id });
    await vi.waitFor(() => expect(requests.some((r) => JSON.stringify(r.messages).includes('"toolUseId":"own-8"'))).toBe(true), { timeout: 90_000, interval: 200 });
    clearInterval(approver);

    const results = requests.at(-1)!.messages.flatMap((m) => m.content).flatMap((b) => (b.type === "tool_result" ? [b.content] : []));
    const device = ((await computer.routes.handle({ method: "GET", path: "/api/devices" }))!.body as { devices: { id: string; name: string }[] }).devices[0]!;
    // Told where it went: the owner's Chrome, by its name.
    expect(results[2]).toContain(`Filled username and password from Shop login (${login}) on ${base}, in the owner's Chrome (${device.name}).`);
    expect(kernel.secretUses.list(login)).toEqual([expect.objectContaining({ outcome: "filled", surface: "chrome", deviceId: device.id, origin: base })]);
    // What it read back says the password is there, never what it is, though the page echoes it into its text and its title.
    for (const look of results.slice(2, 6)) expect(look).not.toContain(password);
    expect(results.slice(3, 5).join("\n")).toContain('textbox "Password" = "(hidden)"');
    expect(results[3]).toContain("typed (hidden)");
    // No script runs in the owner's Chrome: the extension passes no Runtime.enable on, on any site.
    expect(results[7]).toMatch(/Runtime\.enable is not one the extension passes on/);
    expect(JSON.stringify(requests)).not.toContain(password);
  });
});
