/**
 * The owner's secrets as the dashboard and the API see them (docs/secrets.md).
 *
 * Nothing here carries a value: a summary names a secret's fields and shows
 * a hint, and only a reveal, behind a step-up, answers with one.
 */

export type SecretKind = "login" | "card" | "apikey" | "note";

export type SecretFieldName = "username" | "password" | "number" | "expiry" | "cvc" | "name" | "billing" | "token" | "text";

/** A card's billing address: filled into a form, never scanned for. */
export interface SecretBilling {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
}

/** Where a secret may be used. */
export interface SecretUse {
  /** Sites a form may be filled on: exact `https://host[:port]` or `https://*.example.com`; `http://localhost` alone may be plain. */
  web: { origins: string[]; frames: string[] };
  /** Mac apps, by bundle id. */
  apps: string[];
  /** API hosts http.fetch may send it to, and how. */
  http: { hosts: string[]; as?: "bearer" | "basic" };
}

export interface SecretGrant {
  origin: string;
  at: number;
}

export interface SecretPolicy {
  /** `turn`: one yes covers the rest of the turn; `site`: a remembered grant skips the ask, still audited. */
  ask: "always" | "turn" | "site";
  /** Offered to schedules, dispatches and timers; never by default. */
  unattended: boolean;
  /** The chats it may be used in, or null for any of the owner's. */
  chats: string[] | null;
  grants: SecretGrant[];
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
  /** `env`: a KOS_SECRET_* from the host's env file, shown read-only. */
  source: "vault" | "env";
}

export type SecretSurface = "kos-browser" | "chrome" | "mac" | "http";

export interface SecretUseRow {
  id: number;
  at: number;
  conversationId?: string;
  tool: string;
  surface: SecretSurface;
  origin?: string;
  frameOrigin?: string;
  app?: string;
  fields: string[];
  /** filled | denied | expired | refused:<code> | failed */
  outcome: string;
  approvalId?: number;
  decidedBy?: string;
}

export type VaultSlotKind = "keyfile" | "passphrase";

export interface VaultStatus {
  state: "absent" | "locked" | "ready";
  slots: VaultSlotKind[];
  /** Values the scrubber has masked since the host started. */
  scrubbed: number;
  /** Why a vault that is there is not ready, when it is not the passphrase it waits for. */
  problem?: string;
}

/** What a new secret or an edit gives as its values; an omitted or empty one is unchanged. */
export type SecretValues = Partial<Record<Exclude<SecretFieldName, "billing">, string>> & { billing?: SecretBilling };

/** The fields each kind holds, the first of them the one a bare `{{secret:<handle>}}` means. */
export const SECRET_FIELDS: Readonly<Record<SecretKind, readonly SecretFieldName[]>> = {
  login: ["password", "username"],
  card: ["number", "expiry", "cvc", "name", "billing"],
  apikey: ["token", "username"],
  note: ["text"],
};

/** The fields a kind cannot be saved without. */
export const SECRET_REQUIRED: Readonly<Record<SecretKind, readonly SecretFieldName[]>> = {
  login: ["password"],
  card: ["number"],
  apikey: ["token"],
  note: ["text"],
};

export const SECRET_KINDS: readonly SecretKind[] = ["login", "card", "apikey", "note"];
