import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { createDashboardServer, ownHost, sameSecret, withWriteKey, type DashboardServerOptions } from "./server.js";
import { readWriteKey, saveWriteKey, writeKeyPath } from "./writekey.js";

const stub: Inference = {
  async generate() {
    return { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
  },
};

/**
 * A program on this machine sends no Origin, so it passed for the owner:
 * it could set a chat to Auto or approve its own ask. A change now carries
 * the key KOS wrote into its own page at this boot.
 */
describe("this boot's write key", () => {
  let root: string;
  let kernel: Kernel;
  let server: Server;
  let base: string;

  const start = async (token?: string, extra: Partial<DashboardServerOptions> = {}): Promise<void> => {
    const ui = join(root, "ui");
    mkdirSync(ui, { recursive: true });
    writeFileSync(join(ui, "index.html"), "<html><head><title>KOS</title></head><body></body></html>");
    server = createDashboardServer(kernel, { staticDir: ui, ...(token ? { token } : {}), ...extra });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-writekey-"));
    kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets: new SecretsRegistry(), inference: stub, chrome: { port: 1, exists: () => false } });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const keyOf = async (): Promise<string> => {
    const page = await (await fetch(`${base}/`)).text();
    return /<meta name="kos-write" content="([^"]+)">/.exec(page)![1]!;
  };
  const setAuto = (headers: Record<string, string>, id: string): Promise<Response> =>
    fetch(`${base}/api/conversations/mode`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ id, mode: { mode: "auto" } }) });

  it("refuses a change without it, even with no token set, and takes one with it", async () => {
    await start();
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Mine" });
    const bare = await setAuto({}, chat.id);
    expect(bare.status).toBe(403);
    expect((await setAuto({ "x-kos-write": "guessed" }, chat.id)).status).toBe(403);
    expect(kernel.chatMode(chat.id).mode).toBe("ask");
    expect((await fetch(`${base}/api/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1 }) })).status).toBe(403);
    const key = await keyOf();
    expect((await setAuto({ "x-kos-write": key }, chat.id)).status).toBe(200);
    expect(kernel.chatMode(chat.id).mode).toBe("auto");
    // Reads are unchanged.
    expect((await fetch(`${base}/api/status`)).status).toBe(200);
  });

  it("serves the page with the key and keeps it out of any cache", async () => {
    await start();
    const res = await fetch(`${base}/chats`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toMatch(/<meta name="kos-write" content="[A-Za-z0-9_-]{40,}"><\/head>/);
    expect(withWriteKey("<p>x</p>", "k")).toBe('<meta name="kos-write" content="k"><p>x</p>');
  });

  it("takes the owner's token in its place", async () => {
    await start("secret");
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Mine" });
    expect((await setAuto({ "x-kos-token": "secret" }, chat.id)).status).toBe(200);
  });

  it("says from a terminal what to do, and never reads a refused change's body", async () => {
    await start();
    // The body never ends: an answer can only come without it.
    const answer = await new Promise<{ status: number; body: string }>((done, fail) => {
      const req = httpRequest(`${base}/api/message`, { method: "POST", headers: { "content-type": "application/json", "content-length": 300 * 1024 * 1024 } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          done({ status: res.statusCode ?? 0, body });
          req.destroy();
        });
      });
      req.on("error", fail);
      req.write("{");
    });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body).error).toMatch(/From a terminal, use the kos CLI, or send the key in ~\/\.kos\/write\.key/);
  });

  it("in the container serves no key and takes only the token", async () => {
    await start("secret", { tokenForWrites: true });
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Mine" });
    expect(await (await fetch(`${base}/`)).text()).not.toMatch(/kos-write/);
    const refused = await setAuto({ "x-kos-token": "nope" }, chat.id);
    expect(refused.status).toBe(401);
    expect((await setAuto({ "x-kos-token": "secret" }, chat.id)).status).toBe(200);
  });

  it("answers only to its own names and to addresses, on every route", async () => {
    await start(undefined, { hostNames: ["kos.example.com"] });
    const as = (host: string): Promise<number> =>
      new Promise((done) => {
        const req = httpRequest(`${base}/api/status`, { headers: { host } }, (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        });
        req.end();
      });
    expect(await as("evil.example:4317")).toBe(421);
    const said = await new Promise<string>((done) => {
      httpRequest(`${base}/api/status`, { headers: { host: "evil.example" } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => done(body));
      }).end();
    });
    expect((JSON.parse(said) as { error: string }).error).toMatch(/evil\.example.*KOS_HOST_NAMES/);
    expect(await as("localhost:4317")).toBe(200);
    expect(await as("kos.example.com")).toBe(200);
    expect(await as("192.168.1.4:4317")).toBe(200);
    expect(ownHost("[::1]:4317", [])).toBe(true);
    expect(ownHost("rebind.attacker.example", [])).toBe(false);
  });

  it("keeps the key in a file only the owner reads, one per port", () => {
    const file = join(root, "keys", "write.key");
    saveWriteKey(file, "k1");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readWriteKey(file)).toBe("k1");
    expect(writeKeyPath(4317, {})).toMatch(/\.kos\/write\.key$/);
    expect(writeKeyPath(4420, {})).toMatch(/\.kos\/write-4420\.key$/);
    expect(writeKeyPath(4420, { KOS_WRITE_KEY_FILE: "/x/k" })).toBe("/x/k");
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abd", "abc")).toBe(false);
    expect(sameSecret("ab", "abc")).toBe(false);
  });

  it("is never in the environment the host hands its programs", async () => {
    await start();
    const key = await keyOf();
    expect(Object.values(process.env).some((v) => v?.includes(key))).toBe(false);
  });
});
