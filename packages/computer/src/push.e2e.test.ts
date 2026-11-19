import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttp2Server, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openDatabase, type ApprovalDecision, type ModuleContext, type ModuleServices } from "@kos/harness";
import { drawingOf, lookOf } from "@kos/shared";

import { ApnsClient } from "./apns.js";
import { createComputerUse } from "./computeruse.js";
import { rawPublicKey, signText } from "./keys.js";
import { deviceProof, PROTOCOL_VERSION, SOCKET_PATH } from "./protocol.js";
import { PREFIX } from "./routes.js";

/**
 * Push end to end on the KOS side, against fakes at both ends: a phone over a
 * real device socket, and APNs over real HTTP/2. The phone pairs, proves
 * itself and gives its token; an ask is pushed; the phone wakes, decides it
 * over its line, and the settled ask is taken down.
 */

const TOKEN = "0f".repeat(32);
const P8 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function fakeApns(): Promise<{ origin: string; seen: { headers: IncomingHttpHeaders; body: string }[] }> {
  const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Http2Server = createHttp2Server();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (c: string) => (body += c));
    stream.on("end", () => {
      seen.push({ headers, body });
      stream.respond({ ":status": 200 });
      stream.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const until = async (what: string, holds: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (await holds()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}`);
};

describe("push, end to end against a fake phone and a fake APNs", () => {
  it("pushes a new ask to the phone's token, takes its decision over the line, and takes it down once settled", async () => {
    const apns = await fakeApns();
    const sender = new ApnsClient({ origins: { sandbox: apns.origin } });
    const panel = { current: () => undefined, events: () => [] };
    const use = createComputerUse({
      hostKeyPath: join(mkdtempSync(join(tmpdir(), "push-e2e-")), "device-host.key"),
      caller: () => undefined,
      titleOf: (id) => id,
      halted: () => false,
      face: () => drawingOf(lookOf("kos")),
      theme: () => ({ mode: "system" }),
      panels: { chrome: panel, mac: panel, phone: panel },
      push: { env: { key: P8, keyId: "ABC123DEFG", teamId: "DEF123GHIJ", topic: "com.owner.kos-phone" }, sender, log: () => undefined },
    });
    const handlers = new Map<string, Set<(e: unknown) => void>>();
    const events = {
      on: (kind: string, handler: (e: unknown) => void) => {
        handlers.set(kind, (handlers.get(kind) ?? new Set()).add(handler));
        return () => void handlers.get(kind)?.delete(handler);
      },
      emit: (e: { kind: string }) => handlers.get(e.kind)?.forEach((h) => h(e)),
    };
    const secrets = { scrub: (t: string) => t, inVault: () => false, get: () => undefined, attached: () => undefined };
    const ctx = { registerTool: () => undefined, unregisterTool: () => undefined, events, services: { db: openDatabase(":memory:"), secrets } as unknown as ModuleServices } as unknown as ModuleContext;
    await use.module.activate(ctx);
    closers.push(async () => {
      await use.module.deactivate?.();
      await use.close();
    });
    const decided: ApprovalDecision[] = [];
    use.phone.onApproval(async (d) => void decided.push(d));

    const server: Server = createHttpServer();
    server.on("upgrade", (req, socket, head) => {
      if (!use.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));

    // Paired as KOS for iPhone pairs: a code made on the dashboard, then the phone's key.
    const key = generateKeyPairSync("ed25519").privateKey;
    const code = ((await use.routes.handle({ method: "POST", path: `${PREFIX}/pairings` })) as { body: { code: string } }).body.code;
    const paired = (await use.routes.handle({ method: "POST", path: `${PREFIX}/pair`, body: { code, name: "iPhone", platform: "ios", publicKey: rawPublicKey(key) } })) as { body: { device: string } };
    const device = paired.body.device;

    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${SOCKET_PATH}`);
    closers.push(() => ws.close());
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(frame);
      // A phone answers every call KOS makes of it.
      if (frame.t === "call") ws.send(JSON.stringify({ t: "reply", id: frame.id, ok: true, result: {} }));
    });
    await until("the challenge", () => frames.some((f) => f.t === "challenge"));
    const challenge = frames.find((f) => f.t === "challenge")!;
    ws.send(
      JSON.stringify({
        t: "hello",
        protocol: PROTOCOL_VERSION,
        device,
        nonce: "bm9uY2Vub25jZW5vbmNlbm9uY2Vub25jZW5vbmNlISE=",
        signature: signText(key, deviceProof(challenge.nonce as string, device)),
        app: { version: "0.1.0", platform: "ios", os: "26.1" },
        consent: "device",
        permissions: { screen: false, input: false },
        displays: [],
      }),
    );
    await until("the welcome", () => frames.some((f) => f.t === "welcome"));
    const event = (name: string, data: Record<string, unknown>): void => ws.send(JSON.stringify({ t: "event", name, data }));
    event("push.token", { token: TOKEN, env: "sandbox" });

    const listed = async () => ((await use.routes.handle({ method: "GET", path: PREFIX })) as { body: { devices: { push?: unknown }[]; push: unknown } }).body;
    await until("the token kept", async () => JSON.stringify((await listed()).devices[0]?.push) === JSON.stringify({ on: true, env: "sandbox" }));
    expect((await listed()).devices[0]?.push).toEqual({ on: true, env: "sandbox" });
    expect((await listed()).push).toMatchObject({ configured: true, source: "env" });

    use.push.asked({ id: "41", text: "Approve files.write?", tool: "files.write", args: { path: "notes/list.md", content: "the list" }, asker: { name: "Garden", conversationId: "c_2" } });
    await until("the ask pushed", () => apns.seen.length === 1);
    expect(apns.seen[0]!.headers).toMatchObject({ ":path": `/3/device/${TOKEN}`, "apns-topic": "com.owner.kos-phone", "apns-push-type": "alert", "apns-collapse-id": "kos.ask.41" });
    expect(JSON.parse(apns.seen[0]!.body)).toMatchObject({ aps: { alert: { title: "Garden asks" }, category: "kos.ask" }, kos: { ask: "41" } });

    // Approve on the lock screen: the phone decides over its line.
    event("chat.decide", { approval: "41", approved: true });
    await until("the decision", () => decided.length === 1);
    expect(decided).toEqual([{ id: "41", approved: true, deciderId: device }]);

    events.emit({ kind: "approval:decided", id: 41, approved: true, status: "approved", decidedBy: "owner" } as { kind: string });
    await until("the withdrawal", () => apns.seen.length === 2);
    expect(apns.seen[1]!.headers["apns-push-type"]).toBe("background");
    expect(JSON.parse(apns.seen[1]!.body)).toEqual({ aps: { "content-available": 1 }, kos: { settled: "41" } });

    // Unpaired, the token goes with the phone, and the next ask is pushed nowhere.
    await use.routes.handle({ method: "POST", path: `${PREFIX}/remove`, body: { id: device } });
    use.push.asked({ id: "42", text: "Approve files.write?", tool: "files.write", args: { path: "x" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(apns.seen).toHaveLength(2);
  });
});
