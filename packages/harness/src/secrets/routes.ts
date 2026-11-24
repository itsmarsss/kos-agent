import { checkName, nameRefusal, type SecretFieldName, type SecretSummary, type SecretValues, type VaultStatus } from "@kos/shared";

import type { ApiExtension, ApiRequest, ApiResponse } from "../kernel/server.js";
import type { SecretUses } from "../ops/secretuses.js";
import { maskSecret } from "./envfile.js";
import { isKind, RecordError } from "./records.js";
import type { SecretsRegistry } from "./secrets.js";
import { VaultError, type DeviceUnwrapper, type SecretMeta, type Vault } from "./vault.js";

/**
 * The owner's Secrets page, as routes (docs/secrets.md, Routes).
 *
 * Every route sits behind the dashboard's token, and every change behind its
 * write key and the cross-site check, as any route does: the server asks
 * those before an extension is reached. No GET answers with a value. A
 * reveal does, once the owner proves it is them again, a few times in ten
 * minutes at most, and the audit log says it happened.
 */

export const SECRETS_PREFIX = "/api/secrets";

/** Reveals allowed in a window, counting refused ones: the step-up cannot be guessed at speed. */
export const REVEALS_PER_WINDOW = 5;
export const REVEAL_WINDOW_MS = 10 * 60_000;
/** Passphrase tries (unlock, and the current one asked to change it) in the same window, kept apart from reveals. */
export const UNLOCKS_PER_WINDOW = 5;

/** The KOS for Mac on this computer, as the vault's device slot needs it (the computer module's, macvault.ts). */
export interface VaultDevices {
  /** The Mac here that would hold the slot's key, or why there is none now. */
  here(): { id: string; name: string } | { reason: string };
  /** Its vault key, made the first time it is asked: an uncompressed P-256 point. */
  key(device: string): Promise<Buffer>;
  /** Asks that Mac to open a device slot (vault.unwrap). */
  unwrapper(device: string): DeviceUnwrapper;
}

export interface SecretsRoutesDeps {
  vault: Vault;
  secrets: SecretsRegistry;
  uses: SecretUses;
  /** The Mac a device slot is added on; without it, unlock at login is not offered. */
  devices?: VaultDevices;
  /** Into the audit log: names, handles and fields, never a value. */
  audit: (entry: { tool: string; args: Record<string, unknown>; result: string; isError: boolean }) => void;
}

/** Nothing here is cached by a browser or a proxy: a value, or what a list says of one. */
const NO_STORE = { "cache-control": "no-store" };

const ok = (body: unknown): ApiResponse => ({ status: 200, body, headers: NO_STORE });
const fail = (status: number, error: string): ApiResponse => ({ status, body: { error }, headers: NO_STORE });

/** A label refused by the one name check, under the Label field: empty, too long, or another secret's. */
function labelRefused(vault: Vault, label: string, self?: string): ApiResponse | undefined {
  const taken = vault.list().filter((m) => m.handle !== self).map((m) => m.label);
  const check = checkName(label, { noun: "secret", taken });
  return check ? { status: 400, body: nameRefusal(check, "label"), headers: NO_STORE } : undefined;
}

const VAULT_STATUS: Record<VaultError["code"], number> = {
  absent: 409,
  locked: 409,
  exists: 409,
  tampered: 409,
  refused: 409,
  passphrase: 400,
  invalid: 400,
  "not-found": 404,
};

function failed(err: unknown): ApiResponse {
  if (err instanceof VaultError) return fail(VAULT_STATUS[err.code], err.message);
  if (err instanceof RecordError) return fail(400, err.message);
  throw err;
}

const bodyOf = (req: ApiRequest): Record<string, unknown> => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function segment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export function secretsRoutes(deps: SecretsRoutesDeps): ApiExtension {
  const { vault, secrets, uses } = deps;

  const status = (): VaultStatus => {
    const here = deps.devices?.here();
    return { ...vault.status(), scrubbed: secrets.scrubbed(), ...(here ? { mac: "reason" in here ? { reason: here.reason } : { name: here.name } } : {}) };
  };

  /**
   * Unlock at login: a device slot for the Mac here, after it proves its
   * key. It takes the passphrase, a try against the unlock budget: from then
   * on the vault opens with no one typing it, which only its owner says.
   */
  async function addDevice(body: Record<string, unknown>): Promise<ApiResponse> {
    const here = deps.devices?.here();
    if (!here || "reason" in here) return fail(409, here?.reason ?? "this KOS has no computer use, so no Mac can open the vault");
    if (!vault.hasPassphrase()) return fail(400, "set a passphrase first: it is the way back in when the Mac cannot open the vault");
    if (!admitUnlock()) return tooManyTries();
    if (!(await vault.checkPassphrase(text(body.passphrase) ?? ""))) {
      deps.audit({ tool: "secrets.device", args: { change: "add", device: here.id }, result: "refused: not the passphrase", isError: true });
      return fail(400, "that is not the vault's passphrase");
    }
    const key = await deps.devices!.key(here.id);
    const added = await vault.addDeviceSlot(here.name, key, deps.devices!.unwrapper(here.id));
    deps.audit({ tool: "secrets.device", args: { change: "add", slot: added.id, device: here.id }, result: `${added.name} opens the vault at login`, isError: false });
    return ok(status());
  }

  /** A device slot taken off, with the passphrase: a try against the unlock budget. */
  async function removeDevice(body: Record<string, unknown>): Promise<ApiResponse> {
    const slot = text(body.slot);
    if (!slot) return fail(400, "slot is required");
    if (!admitUnlock()) return tooManyTries();
    try {
      await vault.removeDeviceSlot(slot, text(body.passphrase) ?? "");
    } catch (err) {
      if (err instanceof VaultError && err.code === "passphrase") deps.audit({ tool: "secrets.device", args: { change: "remove", slot }, result: "refused: not the passphrase", isError: true });
      throw err;
    }
    deps.audit({ tool: "secrets.device", args: { change: "remove", slot }, result: "device slot removed, data key rotated", isError: false });
    return ok(status());
  }

  const summaryOf = (meta: SecretMeta, last: Map<string, number>): SecretSummary => {
    const { version: _version, ...rest } = meta;
    const at = last.get(meta.handle);
    return { ...rest, ...(at !== undefined ? { lastUsedAt: at } : {}), source: "vault" };
  };

  const envSummary = (name: string, last: Map<string, number>): SecretSummary => {
    const at = last.get(name);
    return {
      handle: name,
      label: name,
      kind: "apikey",
      fields: ["token"],
      hint: maskSecret(secrets.get(name)) ?? "••••",
      use: { web: { origins: [], frames: [] }, apps: [], http: { hosts: secrets.hostsOf(name) ?? [] } },
      policy: { ask: "always", unattended: false, chats: null, grants: [] },
      createdAt: 0,
      updatedAt: 0,
      ...(at !== undefined ? { lastUsedAt: at } : {}),
      source: "env",
    };
  };

  const isEnv = (handle: string): boolean => secrets.envNames().includes(handle);

  /** A try counted against its window, in the database so a restart does not reset it; false when the window is full. */
  const admitReveal = (): boolean => uses.tryOnce("reveal", REVEALS_PER_WINDOW, REVEAL_WINDOW_MS);
  const admitUnlock = (): boolean => uses.tryOnce("unlock", UNLOCKS_PER_WINDOW, REVEAL_WINDOW_MS);
  const tooManyTries = (): ApiResponse => fail(429, `at most ${UNLOCKS_PER_WINDOW} passphrase tries in ${REVEAL_WINDOW_MS / 60_000} minutes; try again later`);

  /**
   * The passphrase added, changed or taken off. Adding one leaves it the
   * vault's only slot and erases the key file; taking it off goes back to a
   * key file. A vault that has one asks for it first.
   */
  async function passphrase(body: Record<string, unknown>): Promise<ApiResponse> {
    const next = text(body.passphrase) || undefined;
    const had = vault.hasPassphrase();
    if (had) {
      if (!admitUnlock()) return tooManyTries();
      if (!(await vault.checkPassphrase(text(body.current) ?? ""))) {
        deps.audit({ tool: "secrets.passphrase", args: { change: next ? "change" : "remove" }, result: "refused: not the current passphrase", isError: true });
        return fail(400, "current is not the vault's passphrase");
      }
    }
    if (next) await vault.setPassphrase(next);
    else if (had) vault.removePassphrase();
    else return fail(400, "this vault has no passphrase to take off; give one to add it");
    deps.audit({ tool: "secrets.passphrase", args: { change: next ? (had ? "change" : "add") : "remove" }, result: next ? "passphrase set, key file erased" : "key-file slot only", isError: false });
    return ok(status());
  }

  async function reveal(handle: string, body: Record<string, unknown>): Promise<ApiResponse> {
    const field = text(body.field) as SecretFieldName | undefined;
    const meta = vault.get(handle);
    if (!meta) return isEnv(handle) ? fail(423, "a secret from the env file is not revealed here; it is in the env file") : fail(404, `there is no secret ${handle}`);
    if (!field || !meta.fields.includes(field)) return fail(400, `field is one of ${meta.fields.join(", ")}`);
    if (!admitReveal()) return fail(429, `at most ${REVEALS_PER_WINDOW} reveals in ${REVEAL_WINDOW_MS / 60_000} minutes; try again later`);
    const passphrase = vault.hasPassphrase();
    // A passphrase asked here is a passphrase guess like an unlock's: one budget for both.
    if (passphrase && !admitUnlock()) return tooManyTries();
    const audited = (result: string, isError: boolean): void => deps.audit({ tool: "secrets.reveal", args: { handle, field, step: passphrase ? "passphrase" : "label" }, result, isError });
    const proved = passphrase ? await vault.checkPassphrase(text(body.passphrase) ?? "") : text(body.label)?.trim() === meta.label;
    if (!proved) {
      audited("refused: the step-up did not match", true);
      return fail(400, passphrase ? "that is not the vault's passphrase" : "type the secret's label exactly to reveal it");
    }
    const value = vault.reveal(handle, field);
    audited("revealed", false);
    return ok({ value });
  }

  async function route(req: ApiRequest): Promise<ApiResponse | undefined> {
    const parts = req.path.slice(SECRETS_PREFIX.length).split("/").filter(Boolean);
    const body = bodyOf(req);
    const { method } = req;

    if (parts.length === 0) {
      if (method === "GET") {
        const last = uses.lastUsed();
        const own = status().state === "ready" ? vault.list().map((m) => summaryOf(m, last)) : [];
        return ok({ secrets: [...own, ...secrets.envNames().map((name) => envSummary(name, last))] });
      }
      if (method === "POST") {
        if (!isKind(body.kind)) return fail(400, "kind is one of login, card, apikey, note");
        if (status().state === "ready") {
          const refused = labelRefused(vault, text(body.label) ?? "");
          if (refused) return refused;
        }
        const handle = vault.add({ label: text(body.label) ?? "", kind: body.kind, values: (body.values ?? {}) as SecretValues, use: body.use, policy: body.policy });
        deps.audit({ tool: "secrets.write", args: { handle, kind: body.kind, fields: vault.get(handle)!.fields }, result: "added", isError: false });
        return ok({ handle });
      }
      return undefined;
    }

    if (parts.length === 1) {
      const [name] = parts as [string];
      if (method === "GET" && name === "status") return ok(status());
      if (method === "POST" && name === "init") {
        const passphrase = text(body.passphrase);
        await vault.init(passphrase ? { passphrase } : {});
        deps.audit({ tool: "secrets.init", args: { passphrase: passphrase !== undefined }, result: "made", isError: false });
        return ok(status());
      }
      if (method === "POST" && name === "unlock") {
        const passphrase = text(body.passphrase);
        if (!passphrase) return fail(400, "passphrase is required");
        if (!admitUnlock()) {
          deps.audit({ tool: "secrets.unlock", args: {}, result: "refused: too many tries", isError: true });
          return tooManyTries();
        }
        try {
          await vault.unlock(passphrase);
        } catch (err) {
          deps.audit({ tool: "secrets.unlock", args: {}, result: `refused: ${err instanceof VaultError ? err.code : "error"}`, isError: true });
          throw err;
        }
        deps.audit({ tool: "secrets.unlock", args: {}, result: "unlocked", isError: false });
        return ok(status());
      }
      if (method === "POST" && name === "passphrase") return passphrase(body);
      if (method === "POST" && name === "devices") return addDevice(body);
      if (method === "POST" && name === "rotate") {
        vault.rotateDataKey();
        deps.audit({ tool: "secrets.rotate", args: { what: "data key" }, result: "rotated", isError: false });
        return ok(status());
      }
      if (method === "POST" && name === "wipe") {
        if (body.confirm !== "wipe") return fail(400, 'confirm with { "confirm": "wipe" }');
        if (vault.hasPassphrase() && !admitUnlock()) return tooManyTries();
        try {
          await vault.wipe(text(body.passphrase));
        } catch (err) {
          if (err instanceof VaultError && err.code === "passphrase") deps.audit({ tool: "secrets.wipe", args: {}, result: "refused: not the passphrase", isError: true });
          throw err;
        }
        deps.audit({ tool: "secrets.wipe", args: {}, result: "wiped", isError: false });
        return ok(status());
      }
      const handle = segment(name);
      if (!handle) return fail(400, "not a handle");
      if (method !== "PATCH" && method !== "DELETE") return undefined;
      if (!isEnv(handle) && vault.status().state !== "ready") return fail(409, vault.status().problem ?? "the vault is not open");
      if (isEnv(handle) && !vault.get(handle)) return fail(423, "a secret from the env file is changed in the env file, not here");
      if (method === "PATCH") {
        if (body.label !== undefined && vault.get(handle)) {
          const refused = labelRefused(vault, text(body.label) ?? "", handle);
          if (refused) return refused;
        }
        const patch = {
          ...(body.label !== undefined ? { label: text(body.label) ?? "" } : {}),
          ...(body.values !== undefined ? { values: body.values as SecretValues } : {}),
          ...(body.use !== undefined ? { use: body.use } : {}),
          ...(body.policy !== undefined ? { policy: body.policy } : {}),
        };
        const meta = vault.update(handle, patch);
        const changed = Object.keys((patch.values ?? {}) as object).filter((f) => (patch.values as Record<string, unknown>)[f] !== "" && (patch.values as Record<string, unknown>)[f] !== undefined);
        deps.audit({ tool: "secrets.write", args: { handle, fields: changed, label: patch.label !== undefined, use: patch.use !== undefined, policy: patch.policy !== undefined }, result: "saved", isError: false });
        return ok(summaryOf(meta, uses.lastUsed()));
      }
      vault.remove(handle);
      uses.forget(handle);
      deps.audit({ tool: "secrets.delete", args: { handle }, result: "deleted, data key rotated", isError: false });
      return ok({ ok: true });
    }

    if (parts.length === 2 && parts[0] === "devices" && parts[1] === "remove" && method === "POST") return removeDevice(body);
    const handle = segment(parts[0]!);
    if (!handle) return fail(400, "not a handle");
    if (!isEnv(handle) && vault.status().state !== "ready") return fail(409, vault.status().problem ?? "the vault is not open");
    if (parts.length === 2 && parts[1] === "uses" && method === "GET") {
      if (!vault.get(handle) && !isEnv(handle)) return fail(404, `there is no secret ${handle}`);
      const query = new URLSearchParams(req.url?.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "");
      return ok({ uses: uses.list(handle, Number(query.get("limit") ?? 50)) });
    }
    if (parts.length === 2 && parts[1] === "reveal" && method === "POST") return reveal(handle, body);
    if (parts.length === 3 && parts[1] === "grants" && method === "DELETE") {
      const origin = segment(parts[2]!);
      if (!origin) return fail(400, "not an origin");
      if (isEnv(handle) && !vault.get(handle)) return fail(423, "a secret from the env file has no grants");
      const meta = vault.revokeGrant(handle, origin);
      deps.audit({ tool: "secrets.write", args: { handle, revoked: origin }, result: "grant revoked", isError: false });
      return ok(summaryOf(meta, uses.lastUsed()));
    }
    return undefined;
  }

  return {
    prefix: SECRETS_PREFIX,
    async handle(req) {
      try {
        return await route(req);
      } catch (err) {
        return failed(err);
      }
    },
  };
}
