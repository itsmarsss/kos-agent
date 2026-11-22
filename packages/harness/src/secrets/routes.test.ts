import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiExtension, ApiResponse } from "../kernel/server.js";
import { SecretUses } from "../ops/secretuses.js";
import { REVEAL_WINDOW_MS, secretsRoutes } from "./routes.js";
import { SecretsRegistry } from "./secrets.js";
import { Vault } from "./vault.js";

let root: string;
let vault: Vault;
let routes: ApiExtension;
let uses: SecretUses;
let audited: { tool: string; args: Record<string, unknown>; result: string; isError: boolean }[];
let clock: number;

/** Asked as the server asks an extension: the path without its query, the url with it. */
const call = async (method: string, url: string, body?: unknown): Promise<ApiResponse> => (await routes.handle({ method, path: url.split("?")[0]!, url, ...(body !== undefined ? { body } : {}) }))!;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kos-secret-routes-"));
  vault = new Vault({ dir: join(root, "secrets") });
  const secrets = SecretsRegistry.fromEnv({ KOS_SECRET_OPENWEATHER: "env-weather-key-0123456789", KOS_SECRET_OPENWEATHER_HOSTS: "api.openweathermap.org" } as NodeJS.ProcessEnv);
  secrets.attachVault(vault);
  uses = new SecretUses(new Database(":memory:"), () => clock);
  audited = [];
  clock = 1_000_000;
  routes = secretsRoutes({ vault, secrets, uses, audit: (e) => audited.push(e) });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const login = { label: "GitHub", kind: "login", values: { username: "owner", password: "pw-route-canary-123" }, use: { web: { origins: ["https://github.com"] } }, policy: { ask: "site" } };

describe("secrets routes", () => {
  it("answers a vault that is not there yet, then makes one", async () => {
    expect((await call("GET", "/api/secrets/status")).body).toEqual({ state: "absent", slots: [], scrubbed: 0 });
    expect((await call("POST", "/api/secrets", login)).status).toBe(409);
    const made = await call("POST", "/api/secrets/init", {});
    expect(made.body).toMatchObject({ state: "ready", slots: ["keyfile"] });
    expect(made.headers?.["cache-control"]).toBe("no-store");
    expect((await call("POST", "/api/secrets/init", {})).status).toBe(409);
  });

  it("adds, lists without values, edits and deletes", async () => {
    await call("POST", "/api/secrets/init", {});
    const added = await call("POST", "/api/secrets", login);
    const { handle } = added.body as { handle: string };
    expect(handle).toMatch(/^github-[a-z0-9]{4}$/);
    const listed = await call("GET", "/api/secrets");
    expect(JSON.stringify(listed.body)).not.toContain("pw-route-canary-123");
    expect(JSON.stringify(listed.body)).not.toContain("env-weather-key-0123456789");
    expect((listed.body as { secrets: unknown[] }).secrets).toEqual([
      expect.objectContaining({ handle, label: "GitHub", kind: "login", fields: ["username", "password"], source: "vault", policy: expect.objectContaining({ ask: "site" }) }),
      expect.objectContaining({ handle: "openweather", source: "env", hint: "••••6789", use: expect.objectContaining({ http: { hosts: ["api.openweathermap.org"] } }) }),
    ]);
    const edited = await call("PATCH", `/api/secrets/${handle}`, { label: "GitHub work", values: { password: "" } });
    expect(edited.body).toMatchObject({ label: "GitHub work", fields: ["username", "password"] });
    expect(vault.value(handle, "password")).toBe("pw-route-canary-123");
    expect((await call("DELETE", `/api/secrets/${handle}`)).body).toEqual({ ok: true });
    expect((await call("PATCH", `/api/secrets/${handle}`, { label: "x" })).status).toBe(404);
    expect(audited.map((a) => a.tool)).toEqual(["secrets.init", "secrets.write", "secrets.write", "secrets.delete"]);
    expect(JSON.stringify(audited)).not.toContain("pw-route-canary-123");
  });

  it("refuses bad input with 400 and an env secret's edit with 423", async () => {
    await call("POST", "/api/secrets/init", {});
    expect((await call("POST", "/api/secrets", { ...login, kind: "pin" })).status).toBe(400);
    expect((await call("POST", "/api/secrets", { ...login, use: { web: { origins: ["ftp://x"] } } })).status).toBe(400);
    expect((await call("PATCH", "/api/secrets/openweather", { label: "x" })).status).toBe(423);
    expect((await call("DELETE", "/api/secrets/openweather")).status).toBe(423);
    expect((await call("POST", "/api/secrets/openweather/reveal", { field: "token" })).status).toBe(423);
    expect((await call("POST", "/api/secrets/wipe", {})).status).toBe(400);
  });

  it("refuses a label another secret has, an empty one or one too long, under the Label field", async () => {
    await call("POST", "/api/secrets/init", {});
    const first = (await call("POST", "/api/secrets", login)).body as { handle: string };
    const dup = await call("POST", "/api/secrets", { ...login, label: " github " });
    expect(dup.status).toBe(400);
    expect(dup.body).toEqual({ field: "label", problem: "taken", error: "There is already a secret called “GitHub”. Pick another name." });
    expect((await call("POST", "/api/secrets", { ...login, label: "" })).body).toMatchObject({ field: "label", problem: "empty" });
    expect((await call("POST", "/api/secrets", { ...login, label: "x".repeat(81) })).body).toMatchObject({ field: "label", problem: "too_long" });
    // Its own label is no clash with itself.
    expect((await call("PATCH", `/api/secrets/${first.handle}`, { label: "GitHub" })).status).toBe(200);
  });

  it("reveals behind the typed label, five times in ten minutes, audited", async () => {
    await call("POST", "/api/secrets/init", {});
    const { handle } = (await call("POST", "/api/secrets", login)).body as { handle: string };
    const wrong = await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", label: "github" });
    expect(wrong.status).toBe(400);
    const right = await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", label: "GitHub" });
    expect(right).toMatchObject({ status: 200, body: { value: "pw-route-canary-123" }, headers: { "cache-control": "no-store" } });
    expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "number", label: "GitHub" })).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "username", label: "GitHub" })).status).toBe(200);
    expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", label: "GitHub" })).status).toBe(429);
    // A restart does not reset it: the tries are in the database.
    routes = secretsRoutes({ vault: new Vault({ dir: join(root, "secrets") }), secrets: new SecretsRegistry(), uses, audit: (e) => audited.push(e) });
    expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", label: "GitHub" })).status).toBe(429);
    clock += REVEAL_WINDOW_MS;
    expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", label: "GitHub" })).status).toBe(200);
    const reveals = audited.filter((a) => a.tool === "secrets.reveal");
    expect(reveals.map((a) => a.isError)).toEqual([true, false, false, false, false, false]);
    expect(JSON.stringify(audited)).not.toContain("pw-route-canary-123");
  });

  it("asks the passphrase when the vault has one, and unlocks with it", async () => {
    await call("POST", "/api/secrets/init", { passphrase: "the vault passphrase" });
    const { handle } = (await call("POST", "/api/secrets", login)).body as { handle: string };
    expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", label: "GitHub" })).status).toBe(400);
    expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", passphrase: "the vault passphrase" })).body).toEqual({ value: "pw-route-canary-123" });
    // A restart: locked until the passphrase.
    routes = secretsRoutes({ vault: new Vault({ dir: join(root, "secrets") }), secrets: new SecretsRegistry(), uses, audit: () => undefined });
    expect((await call("GET", "/api/secrets/status")).body).toMatchObject({ state: "locked" });
    expect((await call("POST", "/api/secrets/unlock", { passphrase: "nope nope nope" })).status).toBe(400);
    expect((await call("POST", "/api/secrets/unlock", { passphrase: "the vault passphrase" })).body).toMatchObject({ state: "ready" });
  }, 20_000);

  it("makes a passphrase vault with that slot alone, and limits unlock tries", async () => {
    expect((await call("POST", "/api/secrets/init", { passphrase: "the vault passphrase" })).body).toMatchObject({ state: "ready", slots: ["passphrase"] });
    routes = secretsRoutes({ vault: new Vault({ dir: join(root, "secrets") }), secrets: new SecretsRegistry(), uses, audit: () => undefined });
    for (let i = 0; i < 4; i++) expect((await call("POST", "/api/secrets/unlock", { passphrase: `wrong guess ${i}` })).status).toBe(400);
    expect((await call("POST", "/api/secrets/unlock", { passphrase: "the vault passphrase" })).status).toBe(200);
    expect((await call("POST", "/api/secrets/unlock", { passphrase: "the vault passphrase" })).status).toBe(429);
    clock += REVEAL_WINDOW_MS;
    expect((await call("POST", "/api/secrets/unlock", { passphrase: "wrong once more" })).status).toBe(400);
  }, 30_000);

  it("wipes a passphrase vault only with its passphrase, and counts the tries with unlock and reveal", async () => {
    await call("POST", "/api/secrets/init", { passphrase: "the vault passphrase" });
    const { handle } = (await call("POST", "/api/secrets", login)).body as { handle: string };
    expect((await call("POST", "/api/secrets/wipe", { confirm: "wipe" })).status).toBe(400);
    expect((await call("POST", "/api/secrets/wipe", { confirm: "wipe", passphrase: "not the one" })).status).toBe(400);
    for (let i = 0; i < 2; i++) expect((await call("POST", `/api/secrets/${handle}/reveal`, { field: "password", passphrase: "wrong" })).status).toBe(400);
    expect((await call("POST", "/api/secrets/unlock", { passphrase: "the vault passphrase" })).status).toBe(200);
    // Five passphrase tries spent across wipe, reveal and unlock.
    expect((await call("POST", "/api/secrets/wipe", { confirm: "wipe", passphrase: "the vault passphrase" })).status).toBe(429);
    clock += REVEAL_WINDOW_MS;
    expect((await call("POST", "/api/secrets/wipe", { confirm: "wipe", passphrase: "the vault passphrase" })).body).toMatchObject({ state: "absent" });
  }, 30_000);

  it("adds, changes and takes off the passphrase, audited", async () => {
    await call("POST", "/api/secrets/init", {});
    expect((await call("POST", "/api/secrets/passphrase", {})).status).toBe(400);
    expect((await call("POST", "/api/secrets/passphrase", { passphrase: "first passphrase" })).body).toMatchObject({ slots: ["passphrase"] });
    expect(existsSync(join(root, "secrets", "key"))).toBe(false);
    expect((await call("POST", "/api/secrets/passphrase", { current: "not the one", passphrase: "second passphrase" })).status).toBe(400);
    expect((await call("POST", "/api/secrets/passphrase", { current: "first passphrase", passphrase: "second passphrase" })).body).toMatchObject({ slots: ["passphrase"] });
    expect((await call("POST", "/api/secrets/passphrase", { current: "second passphrase" })).body).toMatchObject({ state: "ready", slots: ["keyfile"] });
    expect(new Vault({ dir: join(root, "secrets") }).status().state).toBe("ready");
    expect(audited.filter((a) => a.tool === "secrets.passphrase").map((a) => [a.args.change, a.isError])).toEqual([
      ["add", false],
      ["change", true],
      ["change", false],
      ["remove", false],
    ]);
    expect(JSON.stringify(audited)).not.toMatch(/first passphrase|second passphrase/);
  }, 30_000);

  it("lists uses, revokes a grant, rotates and wipes", async () => {
    await call("POST", "/api/secrets/init", {});
    const { handle } = (await call("POST", "/api/secrets", login)).body as { handle: string };
    uses.record({ secret: handle, tool: "secrets.fill", surface: "kos-browser", origin: "https://github.com", fields: ["password"], outcome: "filled" });
    const listed = await call("GET", `/api/secrets/${handle}/uses?limit=10`);
    expect(listed.body).toEqual({ uses: [expect.objectContaining({ tool: "secrets.fill", surface: "kos-browser", origin: "https://github.com", fields: ["password"], outcome: "filled" })] });
    expect((await call("GET", "/api/secrets")).body).toMatchObject({ secrets: [expect.objectContaining({ handle, lastUsedAt: clock }), expect.objectContaining({ source: "env" })] });
    expect((await call("GET", "/api/secrets/nope-0000/uses")).status).toBe(404);
    const revoked = await call("DELETE", `/api/secrets/${handle}/grants/${encodeURIComponent("https://github.com")}`);
    expect(revoked.body).toMatchObject({ handle, policy: { grants: [] } });
    expect((await call("POST", "/api/secrets/rotate")).body).toMatchObject({ state: "ready" });
    expect((await call("POST", "/api/secrets/wipe", { confirm: "wipe" })).body).toMatchObject({ state: "absent" });
    expect(audited.map((a) => a.tool)).toContain("secrets.rotate");
    expect(audited.map((a) => a.tool)).toContain("secrets.wipe");
  });
});

describe("secrets routes on a vault that is not open", () => {
  it("answers 409 for a handle, not 404", async () => {
    await call("POST", "/api/secrets/init", { passphrase: "the vault passphrase" });
    const { handle } = (await call("POST", "/api/secrets", login)).body as { handle: string };
    routes = secretsRoutes({ vault: new Vault({ dir: join(root, "secrets") }), secrets: new SecretsRegistry(), uses, audit: () => undefined });
    for (const [method, path] of [["GET", `/api/secrets/${handle}/uses`], ["POST", `/api/secrets/${handle}/reveal`], ["PATCH", `/api/secrets/${handle}`], ["DELETE", `/api/secrets/${handle}`]] as const) {
      expect((await call(method, path, {})).status).toBe(409);
    }
  }, 20_000);
});
