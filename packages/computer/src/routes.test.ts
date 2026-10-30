import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openDatabase } from "@kos/harness";

import { DeviceHub } from "./hub.js";
import { rawPublicKey, signText, verifyText } from "./keys.js";
import { deviceProof, hostProof, PROTOCOL_VERSION, SOCKET_PATH } from "./protocol.js";
import { deviceRoutes, deviceSocketServer, PREFIX } from "./routes.js";
import { DeviceStore } from "./store.js";

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };

const newHub = () => new DeviceHub({ store: new DeviceStore(openDatabase(":memory:")), hostKey, halted: () => false });

let server: Server | undefined;
let closeSockets: (() => void) | undefined;
afterEach(async () => {
  closeSockets?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
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
    const id = (paired!.body as { device: string }).device;
    const again = await routes.handle({ method: "POST", path: `${PREFIX}/pair`, body: { code, name: "Laptop", platform: "macos", publicKey } });
    expect(again?.status).toBe(403);
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/rename`, body: { id, name: "Work laptop" } })).toMatchObject({ body: { name: "Work laptop" } });
    expect(await routes.handle({ method: "GET", path: PREFIX })).toMatchObject({ body: { devices: [{ id, name: "Work laptop", online: false }] } });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/remove`, body: { id } })).toMatchObject({ status: 200 });
    expect(await routes.handle({ method: "GET", path: `${PREFIX}/nope` })).toBeUndefined();
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

  it("leaves other upgrades alone", () => {
    const sockets = deviceSocketServer(() => newHub());
    closeSockets = () => sockets.close();
    expect(sockets.upgrade({ url: "/elsewhere" } as never, {} as never, Buffer.alloc(0))).toBe(false);
  });
});
