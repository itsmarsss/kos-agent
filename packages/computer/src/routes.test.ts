import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openDatabase } from "@kos/harness";

import { DeviceHub } from "./hub.js";
import type { LanStatus } from "./lan.js";
import { rawPublicKey, signText, verifyText } from "./keys.js";
import { deviceProof, hostProof, PROTOCOL_VERSION, SOCKET_PATH } from "./protocol.js";
import { deviceRoutes, deviceSocketServer, isForwarded, isLoopback, PRE_HELLO_BYTES, PREFIX } from "./routes.js";
import { DeviceStore } from "./store.js";

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };

// A line that closes ends its session at once here: the wait for the device to come back is the hub's to test.
const newHub = () => new DeviceHub({ store: new DeviceStore(openDatabase(":memory:")), hostKey, halted: () => false, lineGraceMs: 0, log: () => undefined });

let server: Server | undefined;
let closeSockets: (() => void) | undefined;
afterEach(async () => {
  closeSockets?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe("a device on this computer", () => {
  it("is one that dialled loopback, as itself or IPv4-mapped", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["192.168.1.20", "::ffff:10.0.0.2", "fe80::1", "", undefined, "127.0.0.1.evil"]) expect(isLoopback(a)).toBe(false);
  });

  it("is not one a proxy on this computer passed on", () => {
    expect(isForwarded({ "x-forwarded-for": "100.64.0.9" })).toBe(true);
    expect(isForwarded({ forwarded: "for=100.64.0.9" })).toBe(true);
    expect(isForwarded({ "tailscale-user-login": "owner@example.com" })).toBe(true);
    expect(isForwarded({ host: "127.0.0.1:4317", upgrade: "websocket" })).toBe(false);
  });
});

describe("the device routes", () => {
  it("pair with a code, list, rename and remove", async () => {
    const hub = newHub();
    const routes = deviceRoutes(() => hub, (id) => `chat ${id}`);
    expect(routes.open).toEqual([`${PREFIX}/pair`]);
    const made = await routes.handle({ method: "POST", path: `${PREFIX}/pairings` });
    const { code } = made!.body as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const publicKey = rawPublicKey(generateKeyPairSync("ed25519").privateKey);
    const paired = await routes.handle({ method: "POST", path: `${PREFIX}/pair`, body: { code, name: "Laptop", platform: "macos", publicKey } });
    expect(paired).toMatchObject({ status: 200, body: { hostKey: hostKey.publicKey, protocol: 1 } });
    // Readable from KOS for Chrome's own origin; the code is the proof.
    expect(paired?.headers).toEqual({ "access-control-allow-origin": "*" });
    const id = (paired!.body as { device: string }).device;
    const again = await routes.handle({ method: "POST", path: `${PREFIX}/pair`, body: { code, name: "Laptop", platform: "macos", publicKey } });
    expect(again?.status).toBe(403);
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/rename`, body: { id, name: "Work laptop" } })).toMatchObject({ body: { name: "Work laptop" } });
    expect(await routes.handle({ method: "GET", path: PREFIX })).toMatchObject({ body: { devices: [{ id, name: "Work laptop", online: false }] } });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/remove`, body: { id } })).toMatchObject({ status: 200 });
    expect(await routes.handle({ method: "GET", path: `${PREFIX}/nope` })).toBeUndefined();
  });

  it("read and change the owner's settings", async () => {
    const hub = newHub();
    const routes = deviceRoutes(() => hub, (id) => id);
    expect(await routes.handle({ method: "GET", path: PREFIX })).toMatchObject({ body: { settings: { askMinutes: 15, unattended: false } } });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/settings`, body: { askMinutes: 60 } })).toMatchObject({ body: { askMinutes: 60 } });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/settings`, body: { askMinutes: 9999 } })).toMatchObject({ status: 400 });
  });

  it("turn the Wi-Fi listener on and off with the setting, and give a phone's code where to find KOS", async () => {
    const hub = newHub();
    let on = false;
    const status = (): LanStatus => ({ on, forced: false, port: 4319, urls: on ? ["https://192.168.1.20:4319"] : [], pin: "PIN", words: "AAAA BBBB CCCC DDDD" });
    const lan = {
      status,
      pairing: () => (on ? { url: "https://192.168.1.20:4319", urls: ["https://192.168.1.20:4319"], pin: "PIN", words: "AAAA BBBB CCCC DDDD" } : undefined),
      sync: async (wanted: boolean) => {
        on = wanted;
        return status();
      },
    };
    const routes = deviceRoutes(() => hub, (id) => id, lan);
    expect(await routes.handle({ method: "GET", path: PREFIX })).toMatchObject({ body: { settings: { lan: false }, lan: { on: false } } });
    expect((await routes.handle({ method: "POST", path: `${PREFIX}/pairings` }))!.body).not.toHaveProperty("lan");
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/settings`, body: { lan: true } })).toMatchObject({ body: { lan: true, lanStatus: { on: true } } });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/pairings` })).toMatchObject({ body: { lan: { url: "https://192.168.1.20:4319", pin: "PIN" } } });
    await routes.handle({ method: "POST", path: `${PREFIX}/settings`, body: { lan: false } });
    expect(on).toBe(false);
  });

  it("say so when computer use is switched off", async () => {
    const routes = deviceRoutes(() => undefined, (id) => id);
    expect(await routes.handle({ method: "GET", path: PREFIX })).toMatchObject({ status: 503 });
  });
});

describe("the device socket", () => {
  it("runs the handshake and a call over a real WebSocket", async () => {
    const hub = newHub();
    const sockets = deviceSocketServer(() => hub);
    closeSockets = () => sockets.close();
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      if (!sockets.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const deviceKey = generateKeyPairSync("ed25519").privateKey;
    const { device } = hub.pair({ code: hub.issueCode().code, name: "Laptop", platform: "macos", publicKey: rawPublicKey(deviceKey) });
    const ws = new WebSocket(`ws://127.0.0.1:${port}${SOCKET_PATH}`);
    const frames: Record<string, unknown>[] = [];
    const next = (): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const have = frames.shift();
        if (have) return resolve(have);
        ws.once("message", () => resolve(frames.shift()!));
      });
    ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));

    const challenge = await next();
    expect(challenge).toMatchObject({ t: "challenge", protocol: PROTOCOL_VERSION });
    const myNonce = "bm9uY2Vub25jZW5vbmNlbm9uY2Vub25jZW5vbmNlISE=";
    ws.send(
      JSON.stringify({
        t: "hello",
        protocol: PROTOCOL_VERSION,
        device,
        nonce: myNonce,
        signature: signText(deviceKey, deviceProof(challenge.nonce as string, device)),
        app: { version: "0.1.0", platform: "macos", os: "26" },
        consent: "device",
        permissions: { screen: true, input: true },
        displays: [],
      }),
    );
    const welcome = await next();
    expect(welcome.t).toBe("welcome");
    expect(verifyText(hostKey.publicKey, hostProof(myNonce, device), welcome.signature as string)).toBe(true);

    const begun = hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    const call = await next();
    expect(call).toMatchObject({ t: "call", method: "session.begin" });
    ws.send(JSON.stringify({ t: "reply", id: call.id, ok: true, result: { granted: true, until: Date.now() + 60_000, space: { width: 800, height: 500 } } }));
    expect((await begun).space).toEqual({ width: 800, height: 500 });

    const gone = new Promise<void>((r) => ws.once("close", () => r()));
    ws.close();
    await gone;
    await new Promise((r) => setTimeout(r, 20));
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(hub.list()[0]?.online).toBe(false);
  });

  /** A device socket server on a real port, and a way to open sockets to it. */
  async function listening(): Promise<(headers?: Record<string, string>) => WebSocket> {
    const sockets = deviceSocketServer(() => newHub());
    closeSockets = () => sockets.close();
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      if (!sockets.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    return (headers = {}) => new WebSocket(`ws://127.0.0.1:${port}${SOCKET_PATH}`, { headers });
  }

  /** How an opened socket fares: refused with a status, or open and then closed. */
  const fate = (ws: WebSocket): Promise<{ status?: number; opened: boolean }> =>
    new Promise((resolve) => {
      let opened = false;
      ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0, opened }));
      ws.on("open", () => (opened = true));
      ws.on("error", () => undefined);
      ws.on("close", () => resolve({ opened }));
    });

  it("refuses a web page's upgrade, and takes a device's and an extension's", async () => {
    const open = await listening();
    expect(await fate(open({ origin: "https://evil.example" }))).toEqual({ status: 403, opened: false });
    expect(await fate(open({ origin: "http://127.0.0.1:4317" }))).toEqual({ status: 403, opened: false });
    const extension = open({ origin: "chrome-extension://abcdefghijklmnop" });
    await new Promise((r) => extension.once("open", r));
    const device = open();
    await new Promise((r) => device.once("open", r));
    extension.close();
    device.close();
  });

  it("keeps few places for sockets that have not proved themselves, and fewer for one address", async () => {
    const open = await listening();
    const held: WebSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const ws = open();
      await new Promise((r) => ws.once("open", r));
      held.push(ws);
    }
    // One address has its share: the next is turned away while those wait on their hello.
    expect((await fate(open())).status).toBe(503);
    held.forEach((ws) => ws.close());
  });

  it("closes a socket that sends more than a hello's worth before proving itself", async () => {
    const open = await listening();
    const ws = open();
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    // Only the start of a frame: it is cut off by its size on the wire, not read whole and found wrong.
    ws.send("x".repeat(PRE_HELLO_BYTES * 4), { fin: false });
    await closed;
  });

  it("leaves other upgrades alone", () => {
    const sockets = deviceSocketServer(() => newHub());
    closeSockets = () => sockets.close();
    expect(sockets.upgrade({ url: "/elsewhere" } as never, {} as never, Buffer.alloc(0))).toBe(false);
  });
});
