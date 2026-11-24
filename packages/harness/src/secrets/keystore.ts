import { findSecret, isWritableKey, maskSecret, namesFor, WRITABLE_SECRETS, writeEnvFile } from "./envfile.js";
import { harnessNameOf, type SecretsRegistry } from "./secrets.js";
import type { Vault } from "./vault.js";

/**
 * Where the Settings page keeps a key KOS runs on (docs/configuration.md,
 * Keys): in the vault while it is open, as an API key naming its harness
 * name (`use.harness`), and out of `.env`, so the env does not shadow it;
 * in `.env` only when there is no vault. A locked vault takes nothing: the
 * key would land where the owner did not mean it.
 */

export type KeyStore = "vault" | "env" | "locked";

export class KeyStoreError extends Error {}

/** Where a key saved now would go. */
export function keyStoreOf(vault: Vault | undefined): KeyStore {
  const state = vault?.status().state ?? "absent";
  return state === "ready" ? "vault" : state === "locked" ? "locked" : "env";
}

export interface SavedKeys {
  /** Where the keys KOS runs on went. */
  stored: KeyStore;
  written: string[];
  cleared: string[];
}

/** Each writable setting saved: keys KOS runs on to the vault when it is open, everything else to `.env`. */
export function saveSettingsKeys(values: Record<string, string | null>, at: { vault: Vault | undefined; envPath: string; workspaceRoot: string; env?: NodeJS.ProcessEnv }): SavedKeys {
  const env = at.env ?? process.env;
  const stored = keyStoreOf(at.vault);
  const keys = Object.keys(values).filter((key) => isWritableKey(key) && key in WRITABLE_SECRETS && harnessNameOf(key) !== undefined);
  if (keys.length && stored === "locked") throw new KeyStoreError("the vault is locked: unlock it (or let KOS for Mac open it) to save a key there");
  const written: string[] = [];
  const cleared: string[] = [];
  const toEnv: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!isWritableKey(key)) continue;
    const name = keys.includes(key) ? harnessNameOf(key) : undefined;
    if (!name || stored !== "vault") {
      toEnv[key] = value;
      continue;
    }
    const vault = at.vault!;
    const existing = vault.harness(name);
    if (!value) {
      if (existing) vault.remove(existing.handle);
      cleared.push(key);
    } else {
      if (existing) vault.update(existing.handle, { values: { token: value } });
      else vault.add({ label: `${WRITABLE_SECRETS[key]!.label} key for KOS`, kind: "apikey", values: { token: value }, use: { harness: name } });
      written.push(key);
    }
    // Out of .env too, under every name it is read by, or the env would win over the vault.
    if (namesFor(key).some((n) => findSecret(n, env))) toEnv[key] = null;
  }
  if (Object.keys(toEnv).length) {
    const result = writeEnvFile(at.envPath, at.workspaceRoot, toEnv);
    for (const key of result.written) written.push(key);
    for (const key of result.cleared) if (!cleared.includes(key) && !written.includes(key)) cleared.push(key);
  }
  // This process too, so a key saved works on the next turn, not the next restart.
  for (const [key, value] of Object.entries(toEnv)) {
    for (const name of namesFor(key)) delete env[name];
    if (value) env[key] = value;
  }
  return { stored, written, cleared };
}

export interface MaskedKey {
  label: string;
  hint: string;
  masked: string | null;
  /** The name it is under in the env, when that is not the one the page shows. */
  storedAs?: string;
  /** Where the live value is read from: the env wins over the vault. */
  source?: "env" | "vault";
}

/** Every writable secret, masked, with where its live value is read from. */
export function maskedKeys(secrets: SecretsRegistry, env: NodeJS.ProcessEnv = process.env): Record<string, MaskedKey> {
  const out: Record<string, MaskedKey> = {};
  for (const [key, meta] of Object.entries(WRITABLE_SECRETS)) {
    const name = harnessNameOf(key);
    const found = findSecret(key, env);
    const vault = !found && name && secrets.sourceOf(name)?.source === "vault" ? secrets.credential(name) : undefined;
    out[key] = {
      label: meta.label,
      hint: meta.hint,
      masked: maskSecret(found?.value ?? vault),
      ...(found && found.name !== key ? { storedAs: found.name } : {}),
      ...(found ? { source: "env" as const } : vault ? { source: "vault" as const } : {}),
    };
  }
  return out;
}
