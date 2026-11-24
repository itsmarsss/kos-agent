import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveSettingsKeys, maskedKeys } from "./keystore.js";
import { SecretsRegistry } from "./secrets.js";
import { Verifiers } from "./verifiers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kos-verifiers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verifiers", () => {
  it("keep a check of a secret, never the secret, and tell it apart", () => {
    const verifiers = new Verifiers(dir);
    expect(verifiers.has("hook")).toBe(false);
    expect(verifiers.matches("hook", "anything")).toBe(false);
    verifiers.set("hook", "hook-secret-canary-0123");
    expect(verifiers.has("hook")).toBe(true);
    expect(verifiers.matches("hook", "hook-secret-canary-0123")).toBe(true);
    expect(verifiers.matches("hook", "hook-secret-canary-0124")).toBe(false);
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), "utf8")).not.toContain("hook-secret-canary");
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
    // Another host's pepper makes another check: a copy of the file alone opens nothing.
    expect(new Verifiers(mkdtempSync(join(tmpdir(), "kos-verifiers-other-"))).matches("hook", "hook-secret-canary-0123")).toBe(false);
    verifiers.set("hook", null);
    expect(verifiers.has("hook")).toBe(false);
  });

  it("take the hook secret from Settings, and refuse it while .env holds one", () => {
    const verifiers = new Verifiers(dir);
    const at = { vault: undefined, verifiers, envPath: join(dir, ".env"), workspaceRoot: join(dir, "workspace") };
    expect(saveSettingsKeys({ KOS_HOOK_SECRET: "hook-secret-canary-0123" }, { ...at, env: {} })).toEqual({ stored: "env", written: ["KOS_HOOK_SECRET"], cleared: [] });
    expect(verifiers.matches("hook", "hook-secret-canary-0123")).toBe(true);
    expect(() => readFileSync(join(dir, ".env"), "utf8")).toThrow();
    expect(maskedKeys(new SecretsRegistry(), {}, verifiers).KOS_HOOK_SECRET).toMatchObject({ masked: "••••", source: "check" });
    expect(() => saveSettingsKeys({ KOS_HOOK_SECRET: "new" }, { ...at, env: { KOS_HOOK_SECRET: "from-env" } })).toThrow(/set in .env, which wins/);
    saveSettingsKeys({ KOS_HOOK_SECRET: null }, { ...at, env: {} });
    expect(verifiers.has("hook")).toBe(false);
  });
});
