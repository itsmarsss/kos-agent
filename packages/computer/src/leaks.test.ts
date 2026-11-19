import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectChannel,
  createDashboardServer,
  createDashboardSocket,
  handleApiRequest,
  InMemoryAdapter,
  Kernel,
  openDatabase,
  SecretsRegistry,
  usesSecret,
  Vault,
  type ApprovalRequest,
  type GenerateRequest,
  type Inference,
  type ModelResponse,
  type PendingAction,
  type ProgressEvent,
} from "@kos/harness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { OwnerChrome } from "./chrome.js";
import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { CHROME_PANEL, DevicePanel, PHONE_PANEL } from "./panel.js";
import { DeviceStore } from "./store.js";
import { computerModule } from "./tools.js";

/**
 * The leak suite, on fakes: every surface a saved secret or a one-time code
 * is placed through, driven end to end through a real kernel, approvals,
 * device hub, panels and channels, with stub inference and stand-ins only
 * where a browser or a device would be. Three chats run their turns: one
 * in KOS's browser (a login and a one-time code, decided on the dashboard),
 * one in the owner's Chrome over KOS for Chrome's line (a card and a code,
 * decided in its side panel) and one on a Mac (a password and a code,
 * decided on the phone through the dashboard relay). Every page echoes what
 * goes into it, and the owner pastes values into the dashboard and Discord.
 *
 * Afterwards no canary, as it is or in any encoding the scrubber knows, is
 * in the database's files (WAL included) or any table, a transcript, the
 * audit or the asks, memory and what its extraction and the embedder read,
 * what KOS printed, what Discord or SMS was sent, the dashboard socket's
 * frames, any frame the hub sent a device but the one secret.fill or
 * keys.secret that carries it, what the model was sent (tool results
 * among it), a compaction's summary, an artifact's export or the backup.
 * The parts that need Chrome are in harness's leak.chrome.test.ts.
 */

const rand = (n: number): string => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => (b % 36).toString(36)).join("");
function luhnCard(): string {
  const digits = [4, ...Array.from({ length: 14 }, () => Math.floor(Math.random() * 10))];
  const sum = digits
    .slice()
    .reverse()
    .reduce((acc, d, i) => acc + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}
const step = (content: ModelResponse["content"], stopReason: ModelResponse["stopReason"] = "tool_use"): ModelResponse => ({ content, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });

const SITE = "https://shop.example";
const SAFARI = { name: "Safari", bundle: "com.apple.Safari" };
/** What each chat is, said in the owner's first words. */
const MARK = { kos: "[in KOS's browser]", chrome: "[in my Chrome]", mac: "[on my Mac]" } as const;
type Surface = keyof typeof MARK;

/** The value as it is and as the scrubber's encodings write it; a card's digits however they are spaced. */
function formsOf(value: string): string[] {
  const bytes = Buffer.from(value);
  const b64 = (s: string): string[] => [s, s.replace(/=+$/, "")];
  return [...new Set([value, encodeURIComponent(value), bytes.toString("hex"), bytes.toString("hex").toUpperCase(), ...b64(bytes.toString("base64")), ...b64(bytes.toString("base64url"))])];
}

/** Every file under `dir` as text but the live database, and every git object a snapshot made. */
function filesText(dir: string): string {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (name === ".git" || name === "backup.git") continue;
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.size < 20_000_000) out.push(readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  for (const git of [join(dir, ".git"), join(dir, ".kos", "backup.git")]) {
    try {
      out.push(execFileSync("git", [`--git-dir=${git}`, "cat-file", "--batch-all-objects", "--batch"], { encoding: "latin1", timeout: 30_000, maxBuffer: 512 * 1024 * 1024 }));
    } catch {
      // No repository there.
    }
  }
  return out.join("\n");
}

describe("the leak suite: no secret or code escapes any surface", { timeout: 90_000 }, () => {
  let home: string;
  let root: string;
  let kernel: Kernel;
  let vault: Vault;
  let hub: DeviceHub;
  let chrome: FakeDevice;
  let mac: FakeDevice;
  let phone: FakeDevice;
  let server: Server;
  let socket: WebSocket;
  let discord: InMemoryAdapter;
  let sms: InMemoryAdapter;
  /** The dashboard's address, and the boot's write key its page holds. */
  let at = "";
  const WRITE_KEY = `write-${rand(12)}`;
  const was = process.env["HOME"];
  const chats = {} as Record<Surface, string>;
  const canary = { password: `pw-${rand(20)}`, card: luhnCard(), token: `sk_live_${rand(28)}`, codes: [`${rand(4)}-${rand(4)}`.toUpperCase(), `${rand(8)}`.toUpperCase(), `${rand(3)}${rand(4)}`.toUpperCase()] };
  const handles = { login: "", card: "", key: "" };
  /** Everything that went out, as each surface saw it. */
  const requests: GenerateRequest[] = [];
  const events: ProgressEvent[] = [];
  const printed: string[] = [];
  const logged: string[] = [];
  const embedded: string[] = [];
  const frames: { device: string; text: string }[] = [];
  const socketFrames: string[] = [];
  /** The secret fills and types the stand-in pages took, by chat. */
  const placed: { chat: string; values: string[] }[] = [];

  /** The surface a request's turn is on: by the ids of the calls it made, or its chat when it has made none. */
  const surfaceOf = (request: GenerateRequest): Surface | undefined => {
    const used = request.messages.flatMap((m) => m.content).find((b) => b.type === "tool_use");
    const named = used && "id" in used ? (Object.keys(MARK) as Surface[]).find((s) => used.id.startsWith(`${s}-`)) : undefined;
    return named ?? (Object.keys(MARK) as Surface[]).find((s) => chats[s] !== undefined && chats[s] === kernel.callerConversationId);
  };

  const otpIn = (text: string): string => /otp_[0-9a-f]{8}/.exec(text)?.[0] ?? "otp_missing";
  /** The turns, as a model working through them would call each tool after the last answered. */
  const script: Record<Surface, (n: number, lastResult: string) => [string, Record<string, unknown>] | undefined> = {
    kos: (n, last) =>
      [
        ["secrets.list", {}],
        ["secrets.fill", { secret: handles.login, fields: [{ field: "username", target: "@e3" }, { field: "password", target: "@e4" }], intent: "sign in" }],
        ["secrets.fill", { secret: "code", fields: [{ field: "code", target: "@e7" }], intent: "finish signing in" }],
        // What the page said, copied into a doc as a model might.
        ["artifacts.write", { id: "signin-notes", kind: "doc", title: "Sign-in notes", html: `<article data-doc><h1>Sign-in notes</h1><p>${last.replace(/[<>&]/g, " ")}</p></article>` }],
      ][n] as [string, Record<string, unknown>] | undefined,
    // The code is refused once on the way in, by words that echo it, and filled again by its handle.
    chrome: (n, last) =>
      [
        ["secrets.fill", { secret: handles.card, fields: [{ field: "number", target: "@e5" }], intent: "pay" }],
        ["secrets.fill", { secret: "code", fields: [{ field: "code", target: "@e7" }], intent: "confirm the payment" }],
        ["secrets.fill", { secret: otpIn(last), fields: [{ field: "code", target: "@e7" }], intent: "confirm the payment" }],
      ][n] as [string, Record<string, unknown>] | undefined,
    mac: (n, last) =>
      [
        ["computer.start", { task: "sign in to the shop in Safari" }],
        ["secrets.type", { secret: handles.login, field: "password", intent: "sign in in Safari" }],
        ["secrets.type", { secret: "code", field: "code", intent: "finish signing in" }],
        ["secrets.type", { secret: otpIn(last), field: "code", intent: "finish signing in" }],
      ][n] as [string, Record<string, unknown>] | undefined,
  };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kos-leaks-home-")));
    process.env["HOME"] = home;
    root = mkdtempSync(join(tmpdir(), "kos-leaks-"));
    vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    handles.login = vault.add({ label: "Shop login", kind: "login", values: { username: "owner", password: canary.password }, use: { web: { origins: [SITE] }, apps: [SAFARI.bundle] } });
    handles.card = vault.add({ label: "Visa", kind: "card", values: { number: canary.card, expiry: "04/29", cvc: "123" }, use: { web: { origins: [SITE] } } });
    handles.key = vault.add({ label: "Stripe", kind: "apikey", values: { token: canary.token }, use: { http: { hosts: ["api.stripe.com"] } } });
    const secrets = new SecretsRegistry();
    secrets.attachVault(vault);

    const hostKey = generateKeyPairSync("ed25519").privateKey;
    hub = new DeviceHub({
      store: new DeviceStore(openDatabase(":memory:")),
      hostKey: { privateKey: hostKey, publicKey: rawPublicKey(hostKey) },
      halted: () => false,
      callTimeoutMs: 3_000,
      log: (line) => void logged.push(line),
      scrub: (text) => secrets.scrub(text),
    });
    const pair = (name: string, platform: string): FakeDevice => {
      const fake = new FakeDevice();
      fake.id = hub.pair({ code: hub.issueCode().code, name, platform, publicKey: fake.publicKey }).device;
      for (const m of ["chat.show", "chat.status", "chat.ask", "chat.settled", "chat.chats", "chat.glance", "dashboard.reply", "session.status"]) fake.answers.set(m, () => ({ ok: true, result: {} }));
      const send = fake.socket.send;
      fake.socket.send = (text) => {
        frames.push({ device: name, text });
        send(text);
      };
      hub.accept(fake.socket);
      if (platform === "chrome") fake.hello({ app: { version: "0.1.0", platform: "chrome", os: "macOS" }, permissions: { tabs: true }, displays: [] });
      else fake.hello();
      return fake;
    };
    chrome = pair("Chrome on macOS", "chrome");
    chrome.answers.set("tabs.list", () => ({ ok: true, result: { tabs: [{ id: "88", url: `${SITE}/checkout`, title: "Checkout", handed: true }] } }));
    chrome.answers.set("tabs.open", () => ({ ok: true, result: { tab: "88" } }));
    // A field that will not take the first code, said in words that hold it: a refusal before anything went in.
    let refusedOnce = false;
    chrome.answers.set("secret.fill", (p) => (p["value"] === canary.codes[1] && !refusedOnce && (refusedOnce = true) ? { ok: false, code: "field", message: `the field would not take ${String(p["value"])}` } : { ok: true, result: { filled: true } }));
    mac = pair("Studio MacBook", "macos");
    mac.answers.set("keys.focus", () => ({ ok: true, result: { app: SAFARI, field: { role: "AXTextField", secure: true, window: "Sign in", label: "Password", origin: SITE } } }));
    let typedOnce = false;
    mac.answers.set("keys.secret", (p) => {
      // The Mac turns the first code away, in words that hold it, before it types any of it.
      if (p["text"] === canary.codes[2] && !typedOnce && (typedOnce = true)) return { ok: false, code: "target", message: `Safari would not take ${String(p["text"])}` };
      placed.push({ chat: chats.mac, values: [String(p["text"])] });
      return { ok: true, result: { typed: true, echo: p["text"] } };
    });
    phone = pair("iPhone", "ios");
    const ownerChrome = new OwnerChrome(hub, { saved: () => secrets.browserValues(), savedFor: (o) => secrets.pageValues(o), evalBlocked: (o) => secrets.evalBlocked(o) });

    const inference: Inference = {
      async generate(_task, request) {
        requests.push(JSON.parse(JSON.stringify(request)) as GenerateRequest);
        // A memory pass keeps what the owner said, word for word, as a model might.
        const asked = request.messages[0]?.content.find((b) => b.type === "text");
        const said = asked && "text" in asked ? asked.text : "";
        if (said.includes("New events:")) {
          const events = [...said.matchAll(/\[#(\d+)\] \(user[^)]*\): ([^\n]+)/g)];
          const ops = events.map(([, id, text], i) => ({ op: "add", key: `owner.said_${i}`, value: text, evidence: [Number(id)], confidence: 0.9 }));
          return step([{ type: "text", text: JSON.stringify({ ops }) }], "end_turn");
        }
        // A summary, a title or any other call without tools answers with what it was given, as a careless model might.
        if (!request.tools?.length) return step([{ type: "text", text: said.slice(0, 4000) || "ok" }], "end_turn");
        const surface = surfaceOf(request);
        const results = request.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
        const next = surface && request.tools?.length ? script[surface](results.length, results.at(-1)?.content ?? "") : undefined;
        if (!next) return step([{ type: "text", text: "Done: signed in and paid." }], "end_turn");
        return step([{ type: "tool_use", id: `${surface}-${results.length + 1}`, name: next[0], input: next[1] }]);
      },
    };
    const module = computerModule({
      hub,
      chrome: ownerChrome,
      caller: () => kernel?.callerConversationId,
      titleOf: (id) => id,
      secrets: { vault: () => secrets.attached(), uses: { record: (u) => kernel.secretUses.record(u), list: (h, n) => kernel.secretUses.list(h, n) }, codes: () => secrets.codes },
      settleMs: 0,
      sleep: async () => undefined,
    });
    /** An in-memory channel under a real surface's name, which is what a decision is judged by. */
    const named = (name: string): InMemoryAdapter => Object.defineProperty(new InMemoryAdapter(), "name", { value: name });
    discord = named("discord");
    sms = named("sms");
    const chromePanel = new DevicePanel(CHROME_PANEL, { current: () => (chats.chrome ? { id: chats.chrome, title: "Chrome" } : undefined), events: () => [], log: (line) => void logged.push(line) });
    const phonePanel = new DevicePanel(PHONE_PANEL, {
      current: () => undefined,
      events: () => [],
      dashboard: (req) => handleApiRequest(kernel, req),
      audit: (entry) => void kernel.audit.record({ ...entry, riskTier: "safe" }),
      log: (line) => void logged.push(line),
    });
    for (const panel of [chromePanel, phonePanel]) panel.attach(hub);
    const asked = (action: PendingAction): ApprovalRequest => ({
      id: String(action.id),
      text: `Approve ${action.tool}?`,
      tool: action.tool,
      args: action.args,
      reason: action.reason,
      ...(action.conversationId ? { asker: { name: kernel.titleOf(action.conversationId), conversationId: action.conversationId } } : {}),
      ...(action.secret ? { secret: action.secret, asksAlways: true } : {}),
    });
    kernel = await Kernel.boot({
      rootDir: join(root, "ws"),
      secrets,
      inference,
      extraModules: [module],
      profileOverrides: { name: "Kenny", timezone: "UTC" },
      chrome: { port: 1, exists: () => false },
      // As the host wires it: a secret's ask is told to the chat surfaces, never asked there; every device panel is asked.
      onApprovalRequested: (action) => {
        const request = asked(action);
        for (const adapter of [discord, sms]) void (usesSecret(action.tool, JSON.parse(action.args)) ? adapter.send("owner", { text: `KOS asks to use a secret (#${action.id}). Decide on the dashboard or a paired device.` }) : adapter.requestApproval("owner", request));
        void chromePanel.requestApproval("owner", request);
      },
    });
    for (const adapter of [discord, sms, chromePanel, phonePanel]) await connectChannel(adapter, kernel, { ownerRecipientId: "owner" }).start();
    kernel.setBrowserElsewhere(ownerChrome);
    vi.spyOn(kernel.embedder, "embed").mockImplementation(async (texts) => {
      embedded.push(...texts);
      return texts.map(() => Array.from({ length: kernel.embedder.dimension }, () => 0));
    });
    kernel.progress.subscribe((event) => events.push(JSON.parse(JSON.stringify(event)) as ProgressEvent));

    // KOS's browser, a stand-in page: the fields where the model looked, and a page that echoes what goes in.
    const types: Record<string, string> = { "@e3": "email", "@e4": "password", "@e5": "text", "@e7": "text" };
    const caller = (): string => kernel.callerConversationId ?? "";
    vi.spyOn(kernel, "secretFillUnready").mockReturnValue(undefined);
    vi.spyOn(kernel, "browserUrl").mockImplementation(() => `${SITE}/login`);
    vi.spyOn(kernel, "secretPlace").mockImplementation(() => (caller() === chats.chrome ? { surface: "chrome", device: { id: chrome.id, name: "Chrome on macOS" } } : { surface: "kos-browser" }));
    vi.spyOn(kernel, "secretSpots").mockImplementation(async (refs) => refs.map((ref) => ({ origin: SITE, frameOrigin: SITE, doc: "doc-1", field: { label: `Field ${ref}`, type: types[ref] ?? "text", action: `${SITE}/session`, method: "post" } })));
    vi.spyOn(kernel, "fillSecretsHere").mockImplementation(async (fills) => {
      const chat = caller();
      // In the owner's Chrome the value goes over KOS for Chrome's line, as OwnerChrome sends it.
      if (chat === chats.chrome) {
        const put = (ownerChrome as unknown as { putSecret(c: string, t: string, p: Record<string, unknown>): Promise<void> }).putSecret.bind(ownerChrome);
        for (const fill of fills) await put(chat, "88", { node: 41, frame: "F", doc: fill.expect.doc, origin: fill.expect.origin, frameOrigin: fill.expect.frameOrigin, slot: fill.expect.slot, value: fill.value });
      }
      placed.push({ chat, values: fills.map((f) => f.value) });
      const echoed = fills.map((f) => f.value).join(" ");
      return { text: `title "typed ${echoed}"\ntextbox "Field @e4" = "(hidden)" @e4\ntext "You typed ${echoed}" (base64 ${Buffer.from(echoed).toString("base64")})`, images: [] };
    });

    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        printed.push(String(chunk));
        return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const real = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
        real(...args);
      });
    }

    // The dashboard's socket, watched as a dashboard tab watches it.
    server = createDashboardServer(kernel, { writeKey: WRITE_KEY });
    const live = createDashboardSocket(kernel, {});
    server.on("upgrade", (req, sock, head) => void (live.upgrade(req, sock, head) || sock.destroy()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    at = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    socket = new WebSocket(`ws://${at}/api/socket`, { headers: { origin: `http://${at}` } });
    socket.on("message", (data) => void socketFrames.push(data.toString("latin1")));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ op: "watch", channel: "events" }));
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    socket?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    kernel?.close();
    process.env["HOME"] = was;
    for (const dir of [root, home]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Which canaries are in `text`, in any form. */
  const leaks = (text: string): string[] => {
    const digits = text.replace(/[\s.+_/-]|%20/g, "");
    const all = [canary.password, canary.token, canary.card, ...canary.codes];
    return all.filter((c) => formsOf(c).some((form) => text.includes(form)) || (c === canary.card && digits.includes(c)));
  };
  /** Each ask decided where the owner would: KOS's browser on the dashboard, the owner's Chrome in its side panel, the Mac from the phone. */
  const decideAll = (codes: Record<Surface, string>): (() => void) => {
    const decided = new Set<number>();
    let call = 0;
    const timer = setInterval(() => {
      for (const ask of kernel.approvals.pending()) {
        if (decided.has(ask.id)) continue;
        decided.add(ask.id);
        const code = ask.secret?.code ? (ask.conversationId === chats.kos ? codes.kos : ask.conversationId === chats.chrome ? codes.chrome : codes.mac) : undefined;
        const withCode = code !== undefined ? { code } : {};
        if (ask.secret && ask.conversationId === chats.chrome) chrome.event("chat.decide", { approval: String(ask.id), approved: true, ...withCode });
        else if (ask.secret && ask.conversationId === chats.mac) phone.event("dashboard.request", { call: ++call, method: "POST", path: "/api/approve", body: { id: ask.id, ...withCode } });
        // The dashboard's own request, over HTTP as its page sends it.
        else void fetch(`http://${at}/api/approve`, { method: "POST", headers: { origin: `http://${at}`, "content-type": "application/json", "x-kos-write": WRITE_KEY }, body: JSON.stringify({ id: ask.id, ...withCode }) });
      }
    }, 25);
    return () => clearInterval(timer);
  };
  const turnEnded = (chat: string): boolean => events.some((e) => e.kind === "turn-end" && e.conversationId === chat);

  it("fills, types and pastes on every surface, and keeps no value anywhere but the one call that places it", async () => {
    const owner = kernel.profile.ownerId;
    for (const s of Object.keys(MARK) as Surface[]) chats[s] = kernel.conversations.create({ userId: owner, channel: s === "chrome" ? "chrome" : "dashboard" }).id;
    // The owner's Chrome is where that chat works: a session there, on the checkout tab.
    await hub.begin({ conversation: chats.chrome, device: hub.find(chrome.id)!, task: "pay", requester: "Chrome", minutes: 5 });
    const stop = decideAll({ kos: canary.codes[0]!, chrome: canary.codes[1]!, mac: canary.codes[2]! });
    const said = {
      kos: `${MARK.kos} Sign me in at ${SITE}; my card is ${canary.card.match(/.{4}/g)!.join(" ")}, my password is ${canary.password}.`,
      chrome: `${MARK.chrome} Pay with my Visa.`,
      mac: `${MARK.mac} Sign me in in Safari.`,
    };
    // Baseline: the scan sees what was pasted.
    expect(leaks(said.kos).sort()).toEqual([canary.password, canary.card].sort());
    try {
      for (const s of Object.keys(MARK) as Surface[]) {
        await kernel.handleMessage(said[s], { owner: true, sessionId: chats[s] });
        await vi.waitFor(() => expect(turnEnded(chats[s])).toBe(true), { timeout: 30_000, interval: 50 });
      }
      // On Discord the owner pastes the key; it is masked at the door and the reply goes back.
      await discord.receive({ channel: "discord", senderId: "owner", text: `here is the Stripe key ${canary.token}, remember it` });
      await vi.waitFor(() => expect(discord.sent.length).toBeGreaterThan(0), { timeout: 10_000 });
      // And texts the card's number to KOS.
      await sms.receive({ channel: "sms", senderId: "owner", text: `card ${canary.card.match(/.{4}/g)!.join("-")} for the shop` });
      await vi.waitFor(() => expect(sms.sent.some((m) => !/Decide on the dashboard/.test(m.msg.text ?? ""))).toBe(true), { timeout: 10_000 });
    } finally {
      stop();
    }

    // Each went in once, where it was approved, and nowhere else.
    expect(placed).toEqual([
      { chat: chats.kos, values: ["owner", canary.password] },
      { chat: chats.kos, values: [canary.codes[0]] },
      { chat: chats.chrome, values: [canary.card] },
      { chat: chats.chrome, values: [canary.codes[1]] },
      { chat: chats.mac, values: [canary.password] },
      { chat: chats.mac, values: [canary.codes[2]] },
    ]);
    const sent = JSON.stringify(requests);
    expect(sent).toContain("Filled username and password from Shop login");
    expect(sent).toMatch(/Filled the one-time code \(otp_[0-9a-f]{8}\) on https:\/\/shop\.example, in KOS's own browser/);
    expect(sent).toMatch(/Filled the one-time code \(otp_[0-9a-f]{8}\) on https:\/\/shop\.example, in the owner's Chrome/);
    expect(sent).toMatch(/Typed the one-time code \(otp_[0-9a-f]{8}\) into the password field in Safari/);
    expect(sent).toMatch(/You typed \[secret otp_[0-9a-f]{8}\.code\]/);
    // Each code refused on its way in was kept for one more try, and went in by its handle without a second ask.
    expect(sent).toMatch(/Not filled: the field would not take \[secret otp_[0-9a-f]{8}\.code\].*kept as otp_/);
    expect(sent).toMatch(/Not typed: Safari would not take \[secret otp_[0-9a-f]{8}\.code\].*kept as otp_/);
    expect(discord.sent.some((m) => /Decide on the dashboard or a paired device/.test(m.msg.text ?? ""))).toBe(true);

    // The hub sent each value in the one call that places it; every other frame holds none.
    const carrying = frames.filter((f) => leaks(f.text).length > 0).map((f) => JSON.parse(f.text) as { method?: string });
    expect(carrying.map((f) => f.method)).toEqual(["secret.fill", "secret.fill", "secret.fill", "keys.secret", "keys.secret", "keys.secret"]);

    // A compaction, a memory pass, an artifact's export and a backup, each over what the turns left.
    const compacted = (await handleApiRequest(kernel, { method: "POST", path: "/api/message", body: { text: "/compact", sessionId: chats.kos } })).body as { reply: string };
    await kernel.extractMemory();
    const exported = await handleApiRequest(kernel, { method: "GET", path: "/api/artifacts/signin-notes/export", url: "/api/artifacts/signin-notes/export?format=md" });
    expect(exported.status).toBe(200);
    await kernel.backup.ensureRepo();
    await kernel.backup.snapshot("leak suite");

    const db = kernel.workspace.db;
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    const rowsOf = (name: string): string => JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).raw().all(), (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString("latin1") : typeof v === "bigint" ? String(v) : v));
    const messages = await Promise.all(Object.values(chats).map((id) => handleApiRequest(kernel, { method: "GET", path: `/api/conversations/${encodeURIComponent(id)}/messages` })));
    const memory = await handleApiRequest(kernel, { method: "GET", path: "/api/memory", url: "/api/memory?limit=500" });
    const ws = kernel.workspace.root;
    const surfaces: [string, string][] = [
      ["model requests and tool results", JSON.stringify(requests)],
      ["compaction summary", compacted.reply],
      ["progress events", JSON.stringify(events)],
      ["dashboard socket frames", socketFrames.join("\n")],
      ["transcripts", JSON.stringify(Object.values(chats).map((id) => kernel.sessions.get(id)))],
      ["conversation messages", JSON.stringify(messages.map((m) => m.body))],
      ["memory", JSON.stringify(memory.body)],
      ["embedder inputs", embedded.join("\n")],
      ["audit_log", rowsOf("audit_log")],
      ["pending_actions", rowsOf("pending_actions")],
      ["secret_uses", rowsOf("secret_uses")],
      ["artifact export", JSON.stringify(exported.body)],
      ["Discord", JSON.stringify([discord.sent, discord.approvalsRequested])],
      ["SMS", JSON.stringify([sms.sent, sms.approvalsRequested])],
      ["device frames", frames.filter((f) => !/"method":"(secret\.fill|keys\.secret)"/.test(f.text)).map((f) => f.text).join("\n")],
      ["hub and panel log", logged.join("\n")],
      ["stdout, stderr and console", printed.join("")],
      ["database files, WAL and the backup's snapshot", readdirSync(ws).filter((f) => f.includes(".sqlite")).map((f) => readFileSync(join(ws, f), "latin1")).join("\n")],
      ["workspace files and git objects", filesText(ws)],
    ];
    for (const name of tables) surfaces.push([`table ${name}`, rowsOf(name)]);
    expect(readdirSync(ws)).toContain("kos.snapshot.sqlite");
    expect(compacted.reply).toMatch(/^Compacted \d+ messages/);
    // Every surface named with what it holds, so one run shows every leak.
    expect(surfaces.map(([where, text]) => ({ where, leaks: leaks(text) })).filter((s) => s.leaks.length > 0)).toEqual([]);
  });
});
