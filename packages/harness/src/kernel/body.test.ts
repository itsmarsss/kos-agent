import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { BODY_MAX, FILES_BODY_MAX, createDashboardServer } from "./server.js";

const stub: Inference = {
  async generate() {
    return { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
  },
};

/** A request whose headers go now and whose body only starts: the answer that comes back came without it. */
function begin(port: number, path: string, headers: Record<string, string | number>, first = "{"): Promise<{ status: number; body: string; sent: () => void }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res: IncomingMessage) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, sent: () => req.destroy() }));
    });
    req.on("error", reject);
    req.write(first);
  });
}

describe("what a request may send", () => {
  let root: string;
  let kernel: Kernel;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-body-"));
    kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets: new SecretsRegistry(), inference: stub, chrome: { port: 1, exists: () => false } });
    server = createDashboardServer(kernel, { token: "secret" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("answers a big body without the token before reading it", async () => {
    // The body never ends: an answer can only come without it.
    const res = await begin(port, "/api/message", { "content-length": 400 * 1024 * 1024 });
    res.sent();
    expect(res.status).toBe(401);
  });

  it("refuses a body past its route's ceiling, by what it says and by what it sends", async () => {
    const said = await begin(port, "/api/message", { "content-length": FILES_BODY_MAX + 1, "x-kos-token": "secret" });
    said.sent();
    expect(said.status).toBe(413);
    expect(said.body).toMatch(/a file can be up to 100 MB/);
    // Sent in chunks with no length said: refused once it runs past, not read to its end. The server
    // answers 413 and closes; a client still writing may see the close (EPIPE) before the answer.
    const sent = await new Promise<number | string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/settings", method: "POST", headers: { "x-kos-token": "secret" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      const pump = (left: number): void => {
        if (left <= 0 || req.destroyed) return;
        req.write(chunk, () => pump(left - 1));
      };
      pump(BODY_MAX / chunk.byteLength + 64);
    });
    expect([413, "EPIPE", "ECONNRESET"]).toContain(sent);
  });

  it("reads a body with the token, as the dashboard sends it", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/message`, { method: "POST", headers: { "content-type": "application/json", "x-kos-token": "secret" }, body: JSON.stringify({ text: "" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text required" });
  });
});
