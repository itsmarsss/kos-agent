import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openDatabase } from "@kos/harness";

import { DeviceHub } from "./hub.js";
import { rawPublicKey, signText } from "./keys.js";
import { DeviceLan, RateLimit, addressKey, isPrivateAddress, type LanLimits } from "./lan.js";
import { makeLanCert, pinOf } from "./lancert.js";
import { REFUSED_REASON } from "./link.js";
import { deviceProof, PROTOCOL_VERSION, SOCKET_PATH } from "./protocol.js";
import { DeviceStore } from "./store.js";

/**
 * The listener phones on the Wi-Fi reach KOS through, over real TLS: what it
 * serves, what it refuses, and who it lets in.
 */

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };

let lan: DeviceLan | undefined;
let dir: string | undefined;
afterEach(async () => {
  await lan?.close();
  lan = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(over: { port?: number; forced?: boolean; limits?: Partial<LanLimits>; cert?: string } = {}) {
  const hub = new DeviceHub({ store: new DeviceStore(openDatabase(":memory:")), hostKey, halted: () => false, log: () => undefined });
  dir = mkdtempSync(join(tmpdir(), "kos-lan-"));
  const certPath = join(dir, "device-lan.pem");
  if (over.cert !== undefined) writeFileSync(certPath, over.cert, { mode: 0o600 });
  lan = new DeviceLan(() => hub, { port: over.port ?? 0, host: "127.0.0.1", certPath, forced: over.forced ?? false, ...(over.limits ? { limits: over.limits } : {}) });
  return { hub, lan };
}

/** Raw bytes to the listener over TLS, and everything it answers until it hangs up. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => socket.write(text));
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

/** An upgrade to the device socket: the status line KOS answers, and the socket while it is open. */
function upgradeTo(port: number): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}${SOCKET_PATH}`, { rejectUnauthorized: false });
    ws.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on("upgrade", () => resolve({ status: 101, ws }));
    ws.on("error", () => resolve({ status: 0 }));
  });
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  pin: string;
}

/** One HTTPS request to the listener, the certificate taken as served (a phone pins it rather than trusting it). */
function ask(port: number, method: string, path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, rejectUnauthorized: false, headers: { "content-type": "application/json" } }, (res) => {
      // Read as the answer starts: the socket is gone by its end.
      const raw = (res.socket as TLSSocket).getPeerCertificate().raw;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers, pin: raw ? pinOf(raw).pin : "" });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** Whether anything takes a TCP connection on the port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** A port nothing listens on, for the listener to take when it is turned on. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

const pairBody = (code: string, key: KeyObject, platform = "ios") => ({ code, name: "Pocket", platform, publicKey: rawPublicKey(key) });

/** A device's handshake over the Wi-Fi socket: what KOS answers (welcome) or how it closes the line. */
function handshake(port: number, device: string, key: KeyObject, signWrong = false): Promise<{ welcome?: Record<string, unknown>; close?: { code: number; reason: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}${SOCKET_PATH}`, { rejectUnauthorized: false });
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.t === "challenge") {
        const proof = deviceProof(frame.nonce as string, signWrong ? "someone else" : device);
        ws.send(
          JSON.stringify({
            t: "hello",
            protocol: PROTOCOL_VERSION,
            device,
            nonce: Buffer.alloc(32, 1).toString("base64"),
            signature: signText(key, proof),
            app: { version: "0.1.0", platform: "ios", os: "18.1" },
            consent: "device",
            permissions: { screen: false, input: false },
            displays: [],
          }),
        );
      } else if (frame.t === "welcome") {
        resolve({ welcome: frame });
        ws.close();
      }
    });
    ws.on("close", (code, reason) => resolve({ close: { code, reason: reason.toString() } }));
    ws.on("error", reject);
  });
}

describe("the Wi-Fi listener", () => {
  it("is off by default: nothing listens until the owner turns it on, and it stops when they turn it off", async () => {
    const port = await freePort();
    const { lan } = setup({ port });
    expect(await lan.sync(false)).toMatchObject({ on: false, forced: false, urls: [] });
    expect(await listening(port)).toBe(false);
    expect((await lan.sync(true)).on).toBe(true);
    expect(await listening(port)).toBe(true);
    expect((await lan.sync(false)).on).toBe(false);
    expect(await listening(port)).toBe(false);
  });

  it("is on whatever the setting says when the host forces it", async () => {
    const { lan } = setup({ forced: true });
    expect(await lan.sync(false)).toMatchObject({ on: true, forced: true });
  });

  it("answers its probe and pairing only, over TLS, with the certificate the status pins", async () => {
    const { lan } = setup();
    const status = await lan.sync(true);
    const probe = await ask(status.port, "GET", "/api/devices/lan");
    expect(probe).toMatchObject({ status: 200, body: { kos: true, protocol: PROTOCOL_VERSION } });
    expect(probe.pin).toBe(status.pin);
    expect(status.words).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/api/status"],
      ["GET", "/api/devices"],
      ["POST", "/api/devices/pairings"],
      ["POST", "/api/devices/remove"],
      ["POST", "/api/devices/settings"],
      ["POST", "/api/hooks/x"],
      ["GET", "/index.html"],
    ] as const) {
      expect(await ask(status.port, method, path, method === "POST" ? {} : undefined), `${method} ${path}`).toMatchObject({ status: 404, body: { error: "not found" } });
    }
  });

  it("does not speak plain http", async () => {
    const { lan } = setup();
    const { port } = await lan.sync(true);
    const outcome = await new Promise<string>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/devices/lan" }, (res) => resolve(`answered ${res.statusCode}`));
      req.on("error", () => resolve("refused"));
      req.end();
    });
    expect(outcome).toBe("refused");
  });

  it("pairs a phone with a one-time code, and refuses anything else that would pair", async () => {
    const { hub, lan } = setup();
    const { port } = await lan.sync(true);
    const key = generateKeyPairSync("ed25519").privateKey;
    const { code } = hub.issueCode();
    expect(await ask(port, "POST", "/api/devices/pair", pairBody(code, key, "macos"))).toMatchObject({ status: 403, body: { error: "only a phone pairs over Wi-Fi" } });
    expect(await ask(port, "POST", "/api/devices/pair", "not json")).toMatchObject({ status: 400 });
    expect(await ask(port, "POST", "/api/devices/pair", { ...pairBody(code, key), name: "x".repeat(5000) })).toMatchObject({ status: 413 });
    const paired = await ask(port, "POST", "/api/devices/pair", pairBody(code, key));
    expect(paired).toMatchObject({ status: 200, body: { hostKey: hostKey.publicKey, protocol: PROTOCOL_VERSION } });
    expect(hub.list()).toMatchObject([{ name: "Pocket", platform: "ios", kind: "phone" }]);
    // One use: the same code again is wrong.
    expect(await ask(port, "POST", "/api/devices/pair", pairBody(code, generateKeyPairSync("ed25519").privateKey))).toMatchObject({ status: 403 });
  });

  it("lets a paired phone in, and refuses a bad signature and a device that is not a phone", async () => {
    const { hub, lan } = setup();
    const { port } = await lan.sync(true);
    const phoneKey = generateKeyPairSync("ed25519").privateKey;
    const phone = hub.pair({ code: hub.issueCode().code, name: "Pocket", platform: "ios", publicKey: rawPublicKey(phoneKey) }).device;
    const macKey = generateKeyPairSync("ed25519").privateKey;
    const mac = hub.pair({ code: hub.issueCode().code, name: "Studio MacBook", platform: "macos", publicKey: rawPublicKey(macKey) }).device;
    expect((await handshake(port, phone, phoneKey)).welcome).toMatchObject({ t: "welcome", name: "Pocket" });
    expect((await handshake(port, phone, phoneKey, true)).close).toEqual({ code: 4003, reason: REFUSED_REASON["bad signature"] });
    expect((await handshake(port, mac, macKey)).close).toEqual({ code: 4003, reason: REFUSED_REASON["not a phone"] });
  });

  it("takes five pairing attempts a minute from an address, then asks it to wait", async () => {
    const { lan } = setup();
    const { port } = await lan.sync(true);
    const key = generateKeyPairSync("ed25519").privateKey;
    for (let i = 0; i < 5; i++) expect((await ask(port, "POST", "/api/devices/pair", pairBody("WRNG-CODE", key))).status).toBe(403);
    const sixth = await ask(port, "POST", "/api/devices/pair", pairBody("WRNG-CODE", key));
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
    // The probe is not an attempt at a code, and still answers.
    expect((await ask(port, "GET", "/api/devices/lan")).status).toBe(200);
  });

  it("says where a phone finds it and what it pins, in a pairing code, only while it is on", async () => {
    const { lan } = setup();
    expect(lan.pairing()).toBeUndefined();
    const status = await lan.sync(true);
    expect(lan.pairing()).toEqual({ url: `https://127.0.0.1:${status.port}`, urls: [`https://127.0.0.1:${status.port}`], pin: status.pin, words: status.words });
    await lan.sync(false);
    expect(lan.pairing()).toBeUndefined();
  });

  it("ends where it was last asked when it is turned on and off at once", async () => {
    const port = await freePort();
    const { lan } = setup({ port });
    const on = lan.sync(true);
    const off = await lan.sync(false);
    expect((await on).on).toBe(false);
    expect(off.on).toBe(false);
    expect(await listening(port)).toBe(false);
  });

  it("stays off and says why when its certificate cannot serve, and computer use goes on", async () => {
    // A key and a certificate that each read well but do not belong together.
    const one = makeLanCert(Date.now());
    const other = makeLanCert(Date.now());
    const { lan } = setup({ cert: `${one.key}${other.cert}` });
    const status = await lan.sync(true);
    expect(status.on).toBe(false);
    expect(status.error).toMatch(/certificate could not be used/);
    expect(lan.pairing()).toBeUndefined();
  });

  it("turns away a body too large before reading it, and hangs up", async () => {
    const { lan } = setup();
    const { port } = await lan.sync(true);
    const answer = await raw(port, "POST /api/devices/pair HTTP/1.1\r\nHost: kos\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n");
    expect(answer).toMatch(/^HTTP\/1\.1 413 /);
    expect(answer.toLowerCase()).toContain("connection: close");
  });

  it("takes so many pairing attempts a minute from every address together", async () => {
    const { lan } = setup({ limits: { pairsPerAddress: 100, pairsInAll: 3 } });
    const { port } = await lan.sync(true);
    const key = generateKeyPairSync("ed25519").privateKey;
    for (let i = 0; i < 3; i++) expect((await ask(port, "POST", "/api/devices/pair", pairBody("WRNG-CODE", key))).status).toBe(403);
    const over = await ask(port, "POST", "/api/devices/pair", pairBody("WRNG-CODE", key));
    expect(over.status).toBe(429);
    expect(over.headers.connection).toBe("close");
  });

  it("takes so many socket upgrades a minute, and so many sockets open from one address", async () => {
    const { lan } = setup({ limits: { upgradesInAll: 3, socketsPerAddress: 1 } });
    const { port } = await lan.sync(true);
    const first = await upgradeTo(port);
    expect(first.status).toBe(101);
    // One address holds its share open: the next is turned away while it does.
    expect((await upgradeTo(port)).status).toBe(429);
    first.ws?.close();
    await new Promise<void>((r) => first.ws?.once("close", () => r()));
    // The third of the minute is the last; the fourth waits, whoever asks.
    const third = await upgradeTo(port);
    expect(third.status).toBe(101);
    third.ws?.terminate();
    expect((await upgradeTo(port)).status).toBe(429);
  });

  it("says why when its port is taken", async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", () => r()));
    const { lan } = setup({ port: (taken.address() as AddressInfo).port });
    const status = await lan.sync(true);
    expect(status.on).toBe(false);
    expect(status.error).toMatch(/could not listen on port/);
    await new Promise<void>((r) => taken.close(() => r()));
  });
});

describe("who the Wi-Fi listener serves", () => {
  it("takes the private networks and loopback", () => {
    for (const a of ["10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.3.4", "127.0.0.1", "::1", "fe9f::1", "febf:1::2", "fd7a:115c:a1e0::1", "fc00::1", "fe80::1", "fe80::1%en0", "::ffff:192.168.1.20", "[::1]"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });

  it("refuses every public address, and what is not an address", () => {
    for (const a of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "100.128.0.1", "1.1.1.1", "::ffff:8.8.8.8", "2001:4860:4860::8888", "fec0::1", "", "localhost", "192.168.1"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it("refuses a carrier's shared range, and IPv6 that only starts like a private range", () => {
    // fc::1 is 00fc::1 and fe8::1 is 0fe8::1: neither is unique-local or link-local.
    for (const a of ["100.64.0.1", "100.127.1.1", "::ffff:100.64.0.1", "fc::1", "fd::1", "fe8::1"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});

describe("a rate limit", () => {
  it("takes the limit in a window, says how long to wait, and takes more once the oldest ages out", () => {
    let now = 0;
    const limit = new RateLimit(2, 60_000, () => now);
    expect(limit.take("a")).toBe(0);
    expect(limit.take("a")).toBe(0);
    expect(limit.take("a")).toBe(60);
    expect(limit.take("b")).toBe(0);
    now = 30_000;
    expect(limit.take("a")).toBe(30);
    now = 60_001;
    expect(limit.take("a")).toBe(0);
  });

  it("forgets the least recently used key in a flood, not one still in use", () => {
    const limit = new RateLimit(1, 60_000, () => 0);
    expect(limit.take("a")).toBe(0);
    for (let i = 0; i < 999; i++) limit.take(`k${i}`);
    // Used again, so it is the most recent: the next new key pushes out k0.
    expect(limit.take("a")).toBe(60);
    limit.take("new");
    expect(limit.take("a")).toBe(60);
    expect(limit.take("k0")).toBe(0);
  });

  it("counts an IPv6 address by its /64, and an IPv4 one by itself", () => {
    expect(addressKey("2001:db8:1:2::5")).toBe(addressKey("2001:db8:1:2:aaaa:bbbb:cccc:1"));
    expect(addressKey("2001:db8:1:2::5")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::5")).not.toBe(addressKey("2001:db8:1:2::5"));
    expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("[::1]")).toBe("0:0:0:0::/64");
    expect(addressKey("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(addressKey("192.168.1.21")).toBe("192.168.1.21");
  });
});
