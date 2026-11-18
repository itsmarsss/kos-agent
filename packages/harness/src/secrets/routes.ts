import type { SecretFieldName, SecretSummary, SecretValues, VaultStatus } from "@kos/shared";

import type { ApiExtension, ApiRequest, ApiResponse } from "../kernel/server.js";
import type { SecretUses } from "../ops/secretuses.js";
import { maskSecret } from "./envfile.js";
import { isKind, RecordError } from "./records.js";
import type { SecretsRegistry } from "./secrets.js";
import { VaultError, type SecretMeta, type Vault } from "./vault.js";

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

export interface SecretsRoutesDeps {
  vault: Vault;
  secrets: SecretsRegistry;
  uses: SecretUses;
  /** Into the audit log: names, handles and fields, never a value. */
  audit: (entry: { tool: string; args: Record<string, unknown>; result: string; isError: boolean }) => void;
  now?: () => number;
}

/** Nothing here is cached by a browser or a proxy: a value, or what a list says of one. */
const NO_STORE = { "cache-control": "no-store" };

const ok = (body: unknown): ApiResponse => ({ status: 200, body, headers: NO_STORE });
const fail = (status: number, error: string): ApiResponse => ({ status, body: { error }, headers: NO_STORE });

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
  const now = deps.now ?? Date.now;
  const reveals: number[] = [];
  const unlocks: number[] = [];

  const status = (): VaultStatus => ({ ...vault.status(), scrubbed: secrets.scrubbed() });

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

  /** A try counted against its window; false when the window is full. */
  const admit = (tries: number[], most: number): boolean => {
    const t = now();
    while (tries.length && t - tries[0]! >= REVEAL_WINDOW_MS) tries.shift();
    if (tries.length >= most) return false;
    tries.push(t);
    return true;
  };
  const admitReveal = (): boolean => admit(reveals, REVEALS_PER_WINDOW);
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
      if (!admit(unlocks, UNLOCKS_PER_WINDOW)) return tooManyTries();
      if (!(await vault.checkPassphrase(text(body.current) ?? ""))) {
        deps.audit({ tool: "secrets.passphrase", args: { change: next ? "change" : "remove" }, result: "refused: not the current passphrase", isError: true });
        return fail(400, "current is not the vault's passphrase");
      }
    }
    if (next) await vault.setPassphrase(next);
    else if (had) vault.removePassphrase();
    else return fail(400, "this vault has no passphrase to take off; give one to add it");
    deps.audit({ tool: "secrets.passphrase", args: { change: next ? (had ? "change" : "add") : "remove" }, result: next ? "passphrase slot only, key file erased" : "key-file slot only", isError: false });
    return ok(status());
  }

  async function reveal(handle: string, body: Record<string, unknown>): Promise<ApiResponse> {
    const field = text(body.field) as SecretFieldName | undefined;
    const meta = vault.get(handle);
    if (!meta) return isEnv(handle) ? fail(423, "a secret from the env file is not revealed here; it is in the env file") : fail(404, `there is no secret ${handle}`);
    if (!field || !meta.fields.includes(field)) return fail(400, `field is one of ${meta.fields.join(", ")}`);
    if (!admitReveal()) return fail(429, `at most ${REVEALS_PER_WINDOW} reveals in ${REVEAL_WINDOW_MS / 60_000} minutes; try again later`);
    const passphrase = vault.hasPassphrase();
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
        if (!admit(unlocks, UNLOCKS_PER_WINDOW)) return tooManyTries();
        await vault.unlock(passphrase);
        return ok(status());
      }
      if (method === "POST" && name === "passphrase") return passphrase(body);
      if (method === "POST" && name === "rotate") {
        vault.rotateDataKey();
        deps.audit({ tool: "secrets.rotate", args: { what: "data key" }, result: "rotated", isError: false });
        return ok(status());
      }
      if (method === "POST" && name === "wipe") {
        if (body.confirm !== "wipe") return fail(400, 'confirm with { "confirm": "wipe" }');
        vault.wipe();
        deps.audit({ tool: "secrets.wipe", args: {}, result: "wiped", isError: false });
        return ok(status());
      }
      const handle = segment(name);
      if (!handle) return fail(400, "not a handle");
      if (method !== "PATCH" && method !== "DELETE") return undefined;
      if (!isEnv(handle) && vault.status().state !== "ready") return fail(409, vault.status().problem ?? "the vault is not open");
      if (isEnv(handle) && !vault.get(handle)) return fail(423, "a secret from the env file is changed in the env file, not here");
      if (method === "PATCH") {
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
