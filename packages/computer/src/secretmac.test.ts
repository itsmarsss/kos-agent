import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kernel, openDatabase, SecretsRegistry, Vault, type GenerateRequest, type Inference, type ModuleContext, type ModelResponse, type ProgressEvent } from "@kos/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerChrome } from "./chrome.js";
import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { typingTimeout } from "./secretmac.js";
import { DeviceStore } from "./store.js";
import { computerModule } from "./tools.js";

/**
 * A saved secret typed on a paired Mac, end to end through a real kernel,
 * hub and device line: the owner's turn starts a session, asks to type a
 * password, is approved on the dashboard, and the Mac types it. The value
 * is in exactly one frame the hub sends (keys.secret) and nowhere else:
 * not a row, a transcript, a progress event, what the model is sent, a tool
 * result, the hub's log or what KOS printed.
 */

const step = (content: ModelResponse["content"], stopReason: ModelResponse["stopReason"] = "tool_use"): ModelResponse => ({ content, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" });
const rand = (n: number): string => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => (b % 36).toString(36)).join("");
const SAFARI = { name: "Safari", bundle: "com.apple.Safari" };

describe("a secret typed on the Mac", () => {
  let root: string;
  let kernel: Kernel;
  let fake: FakeDevice;
  let password: string;
  let handle: string;
  /** Every frame the hub sent the Mac, whole. */
  const frames: string[] = [];
  const requests: GenerateRequest[] = [];
  const events: ProgressEvent[] = [];
  const logged: string[] = [];
  const printed: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-mac-secret-"));
    const vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    password = `pw-${rand(24)}`;
    handle = vault.add({ label: "GitHub", kind: "login", values: { username: "owner", password }, use: { web: { origins: ["https://github.com"] }, apps: [SAFARI.bundle] } });
    const secrets = new SecretsRegistry();
    secrets.attachVault(vault);

    const hostKey = generateKeyPairSync("ed25519").privateKey;
    const hub = new DeviceHub({
      store: new DeviceStore(openDatabase(":memory:")),
      hostKey: { privateKey: hostKey, publicKey: rawPublicKey(hostKey) },
      halted: () => false,
      callTimeoutMs: 2_000,
      log: (line) => void logged.push(line),
      scrub: (text) => secrets.scrub(text),
    });
    fake = new FakeDevice();
    fake.answers.set("keys.focus", () => ({ ok: true, result: { app: SAFARI, field: { role: "AXTextField", secure: true, window: "Sign in to GitHub", label: "Password", origin: "https://github.com" } } }));
    fake.answers.set("keys.secret", () => ({ ok: true, result: { typed: true } }));
    fake.id = hub.pair({ code: hub.issueCode().code, name: "Studio MacBook", platform: "macos", publicKey: fake.publicKey }).device;
    const send = fake.socket.send;
    fake.socket.send = (text) => {
      frames.push(text);
      send(text);
    };
    hub.accept(fake.socket);
    fake.hello();

    let at = 0;
    const inference: Inference = {
      async generate(_task, request) {
        requests.push(JSON.parse(JSON.stringify(request)) as GenerateRequest);
        if (!request.tools?.some((t) => t.name === "secrets.type")) return step([{ type: "text", text: "ok" }], "end_turn");
        at += 1;
        if (at === 1) return step([{ type: "tool_use", id: "t1", name: "computer.start", input: { task: "sign in to GitHub in Safari" } }]);
        if (at === 2) return step([{ type: "tool_use", id: "t2", name: "secrets.type", input: { secret: handle, field: "password", intent: "sign in to GitHub" } }]);
        return step([{ type: "text", text: "Signed in." }], "end_turn");
      },
    };
    const module = computerModule({
      hub,
      chrome: new OwnerChrome(hub),
      caller: () => kernel?.callerConversationId,
      titleOf: (id) => id,
      secrets: { vault: () => secrets.attached(), uses: { record: (u) => kernel.secretUses.record(u), list: (h, n) => kernel.secretUses.list(h, n) } },
      settleMs: 0,
      sleep: async () => undefined,
    });
    kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets, inference, extraModules: [module], profileOverrides: { name: "Kenny", timezone: "UTC" } });
    kernel.progress.subscribe((event) => events.push(JSON.parse(JSON.stringify(event)) as ProgressEvent));
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        printed.push(String(chunk));
        return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    kernel?.close();
    for (const list of [frames, requests, events, logged, printed]) list.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it("goes in the one keys.secret frame and nowhere else", async () => {
    const scrubbedBefore = kernel.secrets.scrubbed();
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, channel: "dashboard" });
    const turn = kernel.handleMessage("sign in to GitHub in Safari on my Mac", { owner: true, sessionId: chat.id });
    await vi.waitFor(() => expect(kernel.approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    const ask = kernel.approvals.pending()[0]!;
    expect(ask.tool).toBe("secrets.type");
    expect(ask.secret).toMatchObject({ handle, surface: "mac", app: SAFARI, device: "Studio MacBook" });
    expect(await kernel.approve(ask.id, kernel.profile.ownerId, { surface: "dashboard" })).toMatchObject({ ok: true });
    const res = await turn;
    // The turn waits on the ask and goes on once it is decided: done when the model has heard the outcome.
    await vi.waitFor(() => expect(JSON.stringify(requests)).toContain("Typed password from GitHub"), { timeout: 10_000 });
    await vi.waitFor(() => expect(events.some((e) => e.kind === "turn-end")).toBe(true), { timeout: 10_000 });

    // Typed once, as approved, into the session the owner allowed.
    const typed = fake.calls.filter((c) => c.method === "keys.secret");
    expect(typed).toHaveLength(1);
    expect(typed[0]!.params).toMatchObject({ text: password, field: "password", app: { bundle: SAFARI.bundle }, apps: [SAFARI.bundle], expect: { role: "AXTextField", secure: true, window: "Sign in to GitHub" }, origin: "https://github.com" });
    expect(typed[0]!.params["approved"]).toBe(typed[0]!.params["session"]);
    expect(kernel.secretUses.list(handle)[0]).toMatchObject({ outcome: "filled", surface: "mac", app: SAFARI.bundle, deviceId: fake.id });

    // The one frame that carries it is keys.secret's; every other frame, status lines and asks included, holds none.
    const carrying = frames.filter((f) => f.includes(password));
    expect(carrying).toHaveLength(1);
    expect(JSON.parse(carrying[0]!)).toMatchObject({ t: "call", method: "keys.secret" });
    expect(fake.statuses.length).toBeGreaterThan(0);

    // What the model was sent, every progress event, the transcript, the hub's log and what KOS printed.
    for (const [where, text] of [
      ["model", JSON.stringify(requests)],
      ["progress", JSON.stringify(events)],
      ["transcript", JSON.stringify(kernel.sessions.get(res.sessionId!))],
      ["log", logged.join("\n")],
      ["printed", printed.join("")],
    ] as const) {
      expect({ where, leaked: text.includes(password) }).toEqual({ where, leaked: false });
    }
    // Every text column of every table.
    const db = kernel.workspace.db;
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).raw().all(), (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf8") : typeof v === "bigint" ? String(v) : v));
      expect({ table: name, leaked: rows.includes(password) }).toEqual({ table: name, leaked: false });
    }
    // And none of it was saved by the scrubber: the value never reached a place it guards.
    expect(kernel.secrets.scrubbed()).toBe(scrubbedBefore);
    // The model heard that it was typed, and how to go on.
    expect(JSON.stringify(requests)).toContain(`Typed password from GitHub (${handle}) into the password field in Safari on Studio MacBook`);
  }, 30_000);
});

describe("secrets.type among the computer tools", () => {
  it("is offered only while a computer is paired, and only with the owner's vault at hand", () => {
    const hostKey = generateKeyPairSync("ed25519").privateKey;
    const hub = new DeviceHub({ store: new DeviceStore(openDatabase(":memory:")), hostKey: { privateKey: hostKey, publicKey: rawPublicKey(hostKey) }, halted: () => false, log: () => undefined });
    const offered = (withVault: boolean): Set<string> => {
      const tools = new Set<string>();
      const ctx = { registerTool: (def: { name: string }) => void tools.add(def.name), unregisterTool: (name: string) => tools.delete(name) } as unknown as ModuleContext;
      void computerModule({
        hub,
        chrome: new OwnerChrome(hub),
        caller: () => "c1",
        titleOf: (id) => id,
        ...(withVault ? { secrets: { vault: () => undefined, uses: { record: () => 0, list: () => [] } } } : {}),
      }).activate(ctx);
      return tools;
    };
    const tools = offered(true);
    const bare = offered(false);
    expect(tools.has("secrets.type")).toBe(false);
    const fake = new FakeDevice();
    fake.id = hub.pair({ code: hub.issueCode().code, name: "Studio MacBook", platform: "macos", publicKey: fake.publicKey }).device;
    hub.accept(fake.socket);
    fake.hello();
    expect(tools.has("secrets.type") && tools.has("computer.act")).toBe(true);
    expect(bare.has("computer.act") && !bare.has("secrets.type")).toBe(true);
    hub.remove(fake.id);
    expect(tools.size).toBe(0);
  });
});

describe("the Mac's time to type a secret", () => {
  it("grows with the value, a character at a time, up to a cap", () => {
    expect(typingTimeout("x".repeat(20))).toBe(16_200);
    expect(typingTimeout("x".repeat(1_000))).toBe(75_000);
    expect(typingTimeout("x".repeat(4_000))).toBe(255_000);
    expect(typingTimeout("x".repeat(10_000))).toBe(300_000);
  });
});
