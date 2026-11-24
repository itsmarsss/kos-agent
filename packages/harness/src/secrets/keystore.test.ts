import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { keyStoreOf, maskedKeys, saveSettingsKeys } from "./keystore.js";
import { SecretsRegistry } from "./secrets.js";
import { Vault } from "./vault.js";

let root: string;
let envPath: string;
let workspaceRoot: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kos-keystore-"));
  envPath = join(root, ".env");
  workspaceRoot = join(root, "workspace");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("keys saved from Settings", () => {
  it("go to .env when there is no vault, and say so", () => {
    const env: NodeJS.ProcessEnv = {};
    const vault = new Vault({ dir: join(root, "secrets") });
    expect(keyStoreOf(vault)).toBe("env");
    const saved = saveSettingsKeys({ OPENAI_API_KEY: "sk-proj-env-0123456789", KOS_OWNER_DISCORD: "1234" }, { vault, envPath, workspaceRoot, env });
    expect(saved).toEqual({ stored: "env", written: ["OPENAI_API_KEY", "KOS_OWNER_DISCORD"], cleared: [] });
    expect(readFileSync(envPath, "utf8")).toContain("OPENAI_API_KEY=sk-proj-env-0123456789");
    expect(env.OPENAI_API_KEY).toBe("sk-proj-env-0123456789");
  });

  it("go to the vault while it is open, out of .env, and the live source says vault", async () => {
    writeFileSync(envPath, "# keys\nDISCORD_TOKEN=discord-env-token-0123456789\nKOS_PORT=4317\n");
    const env: NodeJS.ProcessEnv = { DISCORD_TOKEN: "discord-env-token-0123456789" };
    const vault = new Vault({ dir: join(root, "secrets") });
    await vault.init();
    const saved = saveSettingsKeys({ OPENAI_API_KEY: "sk-proj-vault-0123456789", KOS_SECRET_DISCORD: "discord-vault-token-0123456789", KOS_OWNER_DISCORD: "1234" }, { vault, envPath, workspaceRoot, env });
    expect(saved.stored).toBe("vault");
    expect(saved.written.sort()).toEqual(["KOS_OWNER_DISCORD", "KOS_SECRET_DISCORD", "OPENAI_API_KEY"]);
    const file = readFileSync(envPath, "utf8");
    expect(file).not.toContain("discord-env-token");
    expect(file).not.toContain("sk-proj");
    expect(file).toContain("KOS_OWNER_DISCORD=1234");
    expect(env.DISCORD_TOKEN).toBeUndefined();
    expect(vault.harness("openai")?.label).toBe("OpenAI key for KOS");
    const secrets = SecretsRegistry.fromEnv(env);
    secrets.attachVault(vault);
    expect(secrets.credential("discord")).toBe("discord-vault-token-0123456789");
    const masked = maskedKeys(secrets, env);
    expect(masked.OPENAI_API_KEY).toMatchObject({ masked: "••••6789", source: "vault" });
    expect(masked.KOS_SECRET_DISCORD).toMatchObject({ masked: "••••6789", source: "vault" });
    // Saved again: the same entry, changed; cleared: gone from the vault.
    saveSettingsKeys({ OPENAI_API_KEY: "sk-proj-second-9876543210" }, { vault, envPath, workspaceRoot, env });
    expect(vault.list().filter((m) => m.use.harness === "openai")).toHaveLength(1);
    expect(secrets.credential("openai")).toBe("sk-proj-second-9876543210");
    expect(saveSettingsKeys({ OPENAI_API_KEY: null }, { vault, envPath, workspaceRoot, env })).toMatchObject({ cleared: ["OPENAI_API_KEY"] });
    expect(vault.harness("openai")).toBeUndefined();
  });

  it("are refused while the vault is locked, and the env's value shows as the live one", async () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-proj-env-0123456789" };
    const made = new Vault({ dir: join(root, "secrets") });
    await made.init({ passphrase: "a long passphrase" });
    const vault = new Vault({ dir: join(root, "secrets") });
    expect(keyStoreOf(vault)).toBe("locked");
    expect(() => saveSettingsKeys({ OPENAI_API_KEY: "sk-proj-new-0123456789" }, { vault, envPath, workspaceRoot, env })).toThrow(/vault is locked/);
    // A setting that is not a key still saves.
    expect(saveSettingsKeys({ KOS_PORT: "4400" }, { vault, envPath, workspaceRoot, env }).written).toEqual(["KOS_PORT"]);
    const secrets = SecretsRegistry.fromEnv(env);
    secrets.attachVault(vault);
    expect(maskedKeys(secrets, env).OPENAI_API_KEY).toMatchObject({ masked: "••••6789", source: "env" });
  }, 20_000);
});
