/**
 * The secrets API as the dashboard speaks it, in the types of
 * shared/src/secrets.ts. A GET never carries a value; the only answer that
 * does is a reveal, and it goes straight to its caller.
 */

import type { SecretBilling, SecretFieldName, SecretKind, SecretPolicy, SecretSummary, SecretUse, SecretUseRow, SecretValues, VaultStatus } from "@kos/shared";

import { changeHeaders, FieldError, kosFetch, readRefusal } from "./api.js";

export interface SecretDraft {
  label: string;
  kind: SecretKind;
  values: SecretValues;
  use: SecretUse;
  policy: Omit<SecretPolicy, "grants"> & { grants?: SecretPolicy["grants"] };
}

/** A refusal with its status, so a locked vault (409) or a spent try budget (429) can be told apart. */
export class SecretsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What a refusal says to the owner: the server's words, or, past the passphrase try budget, when to try again. */
export function refusal(err: unknown): string {
  if (err instanceof SecretsError && err.status === 429) return "Too many tries. Wait a few minutes, then try again.";
  return err instanceof Error ? err.message : String(err);
}

async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await kosFetch(path, {
    method,
    ...(method === "GET" ? {} : { headers: changeHeaders() }),
    cache: "no-store",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const refused = await readRefusal(res, path);
    // A label refused (taken, too long) goes under its field, as every form's name does.
    if (refused.field && refused.problem) throw new FieldError(refused.message, refused.field, refused.problem);
    throw new SecretsError(refused.message, res.status);
  }
  return (await res.json()) as T;
}

const at = (handle: string): string => `/api/secrets/${encodeURIComponent(handle)}`;

export const secretsApi = {
  status: () => call<VaultStatus>("GET", "/api/secrets/status"),
  init: (passphrase?: string) => call<VaultStatus>("POST", "/api/secrets/init", passphrase ? { passphrase } : {}),
  unlock: (passphrase: string) => call<VaultStatus>("POST", "/api/secrets/unlock", { passphrase }),
  list: () => call<{ secrets: SecretSummary[] }>("GET", "/api/secrets").then((r) => r.secrets),
  create: (draft: SecretDraft) => call<{ handle: string }>("POST", "/api/secrets", draft),
  update: (handle: string, patch: Partial<Omit<SecretDraft, "kind">>) => call<SecretSummary>("PATCH", at(handle), patch),
  remove: (handle: string) => call<{ ok: true }>("DELETE", at(handle)),
  revokeGrant: (handle: string, origin: string) => call<SecretSummary>("DELETE", `${at(handle)}/grants/${encodeURIComponent(origin)}`),
  uses: (handle: string, limit = 50) => call<{ uses: SecretUseRow[] }>("GET", `${at(handle)}/uses?limit=${limit}`).then((r) => r.uses),
  /** A field's value; billing (which answers with an address) is not revealed here. */
  reveal: (handle: string, field: Exclude<SecretFieldName, "billing">, proof: { passphrase: string } | { label: string }) =>
    call<{ value: string }>("POST", `${at(handle)}/reveal`, { field, ...proof }).then((r) => r.value),
  rotate: () => call<VaultStatus>("POST", "/api/secrets/rotate"),
  /** Add or change the passphrase (`passphrase` given), or remove it; `current` when the vault has one. */
  passphrase: (change: { current?: string; passphrase?: string }) => call<VaultStatus>("POST", "/api/secrets/passphrase", change),
  /** Unlock at login: a device slot for the KOS for Mac on this computer. */
  addDevice: () => call<VaultStatus>("POST", "/api/secrets/devices"),
  /** Take a Mac's device slot off; the passphrase holds the vault open from then. */
  removeDevice: (slot: string, passphrase: string) => call<VaultStatus>("POST", "/api/secrets/devices/remove", { slot, passphrase }),
  wipe: (passphrase?: string) => call<VaultStatus>("POST", "/api/secrets/wipe", { confirm: "wipe", ...(passphrase ? { passphrase } : {}) }),
};

/** Each kind in words, and the fields it is made of. */
export const KINDS: Record<SecretKind, { label: string; fields: SecretFieldName[] }> = {
  login: { label: "Login", fields: ["username", "password"] },
  card: { label: "Card", fields: ["number", "expiry", "cvc", "name", "billing"] },
  apikey: { label: "API key", fields: ["token", "username"] },
  note: { label: "Note", fields: ["text"] },
};

export const FIELD_LABEL: Record<SecretFieldName, string> = {
  username: "Username",
  password: "Password",
  number: "Card number",
  expiry: "Expiry",
  cvc: "CVC",
  name: "Name on card",
  billing: "Billing address",
  token: "Token",
  text: "Text",
};

export const BILLING_PARTS: readonly { key: keyof SecretBilling; label: string }[] = [
  { key: "line1", label: "Address" },
  { key: "line2", label: "Address, line 2" },
  { key: "city", label: "City" },
  { key: "region", label: "State or region" },
  { key: "postal", label: "Postal code" },
  { key: "country", label: "Country" },
];

export const ASK_WORDS: Record<SecretPolicy["ask"], string> = {
  always: "Every time",
  turn: "Once per turn",
  site: "Remembered per site",
};

export const SURFACE_WORDS: Record<SecretUseRow["surface"], string> = {
  "kos-browser": "KOS's browser",
  chrome: "Your Chrome",
  mac: "Mac",
  http: "HTTP",
};

export function emptyUse(): SecretUse {
  return { web: { origins: [], frames: [] }, apps: [], http: { hosts: [] } };
}

export function defaultPolicy(): SecretDraft["policy"] {
  return { ask: "always", unattended: false, chats: null };
}

/** Where a secret may be used, in a few words: its first site or host and how many more. */
export function whereWords(use: SecretUse): string {
  const places = [...use.web.origins.map((o) => o.replace(/^https:\/\//, "")), ...use.http.hosts, ...use.apps];
  if (places.length === 0) return "Not usable yet: say where it goes";
  return places.length === 1 ? places[0]! : `${places[0]} and ${places.length - 1} more`;
}
