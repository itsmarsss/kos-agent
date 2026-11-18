/**
 * The secrets API as the dashboard speaks it.
 *
 * The types are the contract's (packages/shared/src/secrets.ts, from the
 * vault's branch); kept here until that lands. A GET never carries a value;
 * the only answer that does is a reveal, and it goes straight to its caller.
 */

import { changeHeaders, readError, tokenHeaders } from "./api.js";

export type SecretKind = "login" | "card" | "apikey" | "note";
export type SecretFieldName = "username" | "password" | "number" | "expiry" | "cvc" | "name" | "billing" | "token" | "text";
export interface SecretUse {
  web: { origins: string[]; frames: string[] };
  apps: string[];
  http: { hosts: string[]; as?: "bearer" | "basic" };
}
export interface SecretPolicy {
  ask: "always" | "turn" | "site";
  unattended: boolean;
  chats: string[] | null;
  grants: { origin: string; at: number }[];
}
export interface SecretSummary {
  handle: string;
  label: string;
  kind: SecretKind;
  fields: SecretFieldName[];
  hint: string;
  use: SecretUse;
  policy: SecretPolicy;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  source: "vault" | "env";
}
export interface SecretUseRow {
  id: number;
  at: number;
  conversationId?: string;
  tool: string;
  surface: "kos-browser" | "chrome" | "mac" | "http";
  origin?: string;
  frameOrigin?: string;
  app?: string;
  fields: string[];
  outcome: string;
  approvalId?: number;
  decidedBy?: string;
}
export interface VaultStatus {
  state: "absent" | "locked" | "ready";
  slots: ("keyfile" | "passphrase")[];
  /** Values masked in KOS's output since boot. */
  scrubbed: number;
}

/** A card's billing address, as its parts. */
export type Billing = Partial<Record<"line1" | "line2" | "city" | "region" | "postal" | "country", string>>;
export type SecretValues = Partial<Record<SecretFieldName, string | Billing>>;

export interface SecretDraft {
  label: string;
  kind: SecretKind;
  values: SecretValues;
  use: SecretUse;
  policy: Omit<SecretPolicy, "grants"> & { grants?: SecretPolicy["grants"] };
}

/** A refusal with its status, so a locked vault (409) or a spent reveal (429) can be told apart. */
export class SecretsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? tokenHeaders() : changeHeaders(),
    cache: "no-store",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new SecretsError(await readError(res, path), res.status);
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
  reveal: (handle: string, field: SecretFieldName, proof: { passphrase: string } | { label: string }) =>
    call<{ value: string }>("POST", `${at(handle)}/reveal`, { field, ...proof }).then((r) => r.value),
  rotate: () => call<VaultStatus>("POST", "/api/secrets/rotate"),
  wipe: () => call<VaultStatus>("POST", "/api/secrets/wipe", { confirm: "wipe" }),
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

export const BILLING_PARTS: readonly { key: keyof Billing; label: string }[] = [
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
  if (places.length === 0) return "Nowhere yet";
  return places.length === 1 ? places[0]! : `${places[0]} and ${places.length - 1} more`;
}
