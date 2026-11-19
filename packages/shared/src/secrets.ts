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
  /** The paired device it went into, for a fill in the owner's Chrome. */
  deviceId?: string;
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

/**
 * The tools whose asks place one of the owner's secrets: asked about every
 * time, never kept as a permission rule, and decided only on the
 * dashboard or a paired device.
 */
export const SECRET_TOOLS: readonly string[] = ["secrets.fill", "secrets.type", "secrets.allow_site", "secrets.request"];

/** What a yes to a secret's ask may be kept as: `site` stops asking on that origin (a grant in the vault). */
export type SecretRemember = "turn" | "site";

/**
 * A secret's ask as every card shows it, stored beside the ask
 * (pending_actions.secret). Never a value.
 */
export interface AskSecret {
  handle: string;
  label: string;
  kind: SecretKind;
  /** The fields it fills, or would be allowed for. */
  fields: SecretFieldName[];
  /** The page's real origin, read from the tab, never from the model. */
  origin?: string;
  /** The frames the fields are in, where those are not the page's origin. */
  frameOrigins: string[];
  surface: SecretSurface;
  /** The paired device it goes into, by name, for a fill in the owner's Chrome. */
  device?: string;
  hint?: string;
  /** What the owner should weigh: a plain-http page, a site the secret was never used on. */
  warnings: string[];
  /** What a yes may be kept as. */
  remember: SecretRemember[];
  /** Each form field it goes into, as the page labels it, and its type. */
  targets?: { field: string; label: string; type: string }[];
  /** Where the fields' form sends what is typed, when they are in one. */
  formAction?: string;
  /** The app it is typed into on a Mac (secrets.type); its field is the one target, as Accessibility names it. */
  app?: { name: string; bundle: string };
}
