import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KosClient, probeDaemon } from "./index.js";

interface Seen {
  method: string;
  url: string;
  auth?: string;
  body: string;
}

describe("KosClient", () => {
  let server: Server;
  let baseUrl: string;
  let seen: Seen[];
  let answer: (req: IncomingMessage) => { status: number; body: unknown };

  beforeEach(async () => {
    seen = [];
    answer = () => ({ status: 200, body: { ok: true } });
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
        const a = answer(req);
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sends the token as a bearer and strips a trailing slash", async () => {
    const c = new KosClient({ baseUrl, token: "t0k" });
    await c.health();
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/health", auth: "Bearer t0k" });
  });

  it("asks a project in its own conversation", async () => {
    answer = () => ({ status: 200, body: { reply: "done", halted: false, sessionId: "project:resume" } });
    const c = new KosClient({ baseUrl });
    const r = await c.ask("resume", "tailor this to the posting");
    expect(r.reply).toBe("done");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/message" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ text: "tailor this to the posting", sessionId: "project:resume" });
    expect(seen[0]!.auth).toBeUndefined();
  });

  it("remembers and forgets through the shared memory", async () => {
    const c = new KosClient({ baseUrl });
    await c.remember("resume_target", "staff engineer roles", { tags: ["resume"], pinned: true });
    await c.forget("resume_target");
    expect(JSON.parse(seen[0]!.body)).toEqual({ key: "resume_target", value: "staff engineer roles", tags: ["resume"], pinned: true });
    expect(seen[1]).toMatchObject({ url: "/api/memory/delete" });
  });

  it("fires a hook with the hook secret, never the dashboard token", async () => {
    answer = () => ({ status: 202, body: { accepted: "nightly" } });
    const c = new KosClient({ baseUrl, token: "dash" });
    expect(await c.fireHook("nightly build", "h00k")).toEqual({ accepted: "nightly" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/hooks/nightly%20build", auth: "Bearer h00k" });
  });

  it("turns a failed request into an error that says what failed", async () => {
    answer = () => ({ status: 401, body: { error: "unauthorized" } });
    await expect(new KosClient({ baseUrl }).status()).rejects.toThrow(/\/api\/status: 401/);
    expect(await probeDaemon(baseUrl)).toBe(false);
    expect(await probeDaemon("http://127.0.0.1:1")).toBe(false);
  });
});
