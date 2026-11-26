import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { Kernel } from "../kernel/kernel.js";
import { handleApiRequest } from "../kernel/server.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Vault } from "../secrets/vault.js";
import type { GoogleView } from "./routes.js";

const stub: Inference = { complete: async () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }) } as unknown as Inference;
const SECRET = "GOCSPX-route-test-secret-000";
const CLIENT = JSON.stringify({ installed: { client_id: "9-x.apps.googleusercontent.com", client_secret: SECRET } });

describe("the Google routes", () => {
  let root: string;
  let kernel: Kernel;
  const before = process.env.KOS_GOOGLE_DIR;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kos-google-api-")));
    process.env.KOS_GOOGLE_DIR = join(root, "google");
    const vault = new Vault({ dir: join(root, "vault") });
    await vault.init();
    const secrets = new SecretsRegistry();
    secrets.attachVault(vault);
    kernel = await Kernel.boot({ rootDir: join(root, "ws"), secrets, inference: stub, chrome: { port: 1, exists: () => false } });
  });

  afterEach(() => {
    kernel.close();
    if (before === undefined) delete process.env.KOS_GOOGLE_DIR;
    else process.env.KOS_GOOGLE_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: Record<string, unknown>) => handleApiRequest(kernel, { method, path, ...(body ? { body } : {}) });

  it("imports the client into the vault and never answers with its secret", async () => {
    const empty = (await call("GET", "/api/google")).body as GoogleView;
    expect(empty).toMatchObject({ client: null, account: null, settings: { on: true, changes: false, send: false }, server: null });
    expect((await call("POST", "/api/google/client", { json: "{nope" })).status).toBe(400);
    const kept = await call("POST", "/api/google/client", { json: CLIENT });
    expect(kept.status).toBe(200);
    expect((kept.body as GoogleView).client).toEqual({ id: "9-x.apps.googleusercontent.com" });
    expect(JSON.stringify(kept.body)).not.toContain(SECRET);
    expect(JSON.stringify((await call("GET", "/api/google")).body)).not.toContain(SECRET);
  });

  it("changes the mode, refuses an empty change, and keeps sending behind changes", async () => {
    expect((await call("POST", "/api/google/settings", {})).status).toBe(400);
    const send = (await call("POST", "/api/google/settings", { send: true })).body as GoogleView;
    expect(send.settings).toEqual({ on: true, changes: false, send: false });
    const both = (await call("POST", "/api/google/settings", { changes: true, send: true })).body as GoogleView;
    expect(both.settings).toEqual({ on: true, changes: true, send: true });
  });

  it("refuses a sign-in with no client", async () => {
    const res = await call("POST", "/api/google/signin");
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/import the Google OAuth client first/);
  });

  it("disconnects with nothing signed in", async () => {
    const res = await call("POST", "/api/google/disconnect");
    expect(res.body).toMatchObject({ accounts: [], revoked: true, account: null });
  });
});
