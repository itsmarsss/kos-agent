import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { createDashboardServer, withWriteKey } from "./server.js";

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

  const start = async (token?: string): Promise<void> => {
    const ui = join(root, "ui");
    mkdirSync(ui, { recursive: true });
    writeFileSync(join(ui, "index.html"), "<html><head><title>KOS</title></head><body></body></html>");
    server = createDashboardServer(kernel, { staticDir: ui, ...(token ? { token } : {}) });
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

  it("is never in the environment the host hands its programs", async () => {
    await start();
    const key = await keyOf();
    expect(Object.values(process.env).some((v) => v?.includes(key))).toBe(false);
  });
});
