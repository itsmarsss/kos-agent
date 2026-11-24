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

export type VaultSlotKind = "keyfile" | "passphrase" | "device";

export interface VaultStatus {
  state: "absent" | "locked" | "ready";
  slots: VaultSlotKind[];
  /** The device slots: each a KOS for Mac that opens the vault while its owner is logged in. */
  devices?: { id: string; name: string }[];
  /** Whether the KOS for Mac on this computer can open the vault at login: its name, or why not. Absent without computer use. */
  mac?: { name: string } | { reason: string };
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

/**
 * The tools whose ask shows the owner's own private data on its card (the
 * start of what they copied): decided as a secret's use is, every time and
 * only on the dashboard or a paired device, so it never lands in a chat
 * surface's history or a notification.
 */
export const PRIVATE_TOOLS: readonly string[] = ["clipboard.read"];

/** What a yes to a secret's ask may be kept as: `site` stops asking on that origin (a grant in the vault). */
export type SecretRemember = "turn" | "site";

/**
 * A secret's ask as every card shows it, stored beside the ask
 * (pending_actions.secret). Never a value.
 */
export interface AskSecret {
  handle: string;
  label: string;
  /** "code" for a one-time code the owner types into the card itself (ONE_TIME_CODE). */
  kind: SecretKind | "code";
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
  /**
   * A one-time code: the card offers a masked input, and a yes sends what
   * the owner typed with it, held in the host's memory alone (docs/secrets.md,
   * One-time codes).
   */
  code?: true;
}

/**
 * The secret a fill or a type names for a one-time code the owner types on
 * the card. A code is never saved: a yes turns it into a handle `otp_<id>`
 * that is used once, within CODE_TTL_MS, on the page or app it was asked for.
 */
export const ONE_TIME_CODE = "code";

/** A one-time code's handle, as the host gives it out. */
export const CODE_HANDLE = /^otp_[0-9a-f]{8}$/;

/** How long a code typed on a card may be used. */
export const CODE_TTL_MS = 5 * 60_000;

/** The shortest and longest code a card takes: shorter would match ordinary words and could not be taken out of what KOS reads back. */
export const CODE_MIN = 6;
export const CODE_MAX = 32;

/** A code as typed, spaces taken out: "123 456" is 123456. */
export function typedCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/** Why what the owner typed is not a code a card takes, or undefined when it is: 6 to 32 letters, digits or dashes. */
export function codeProblem(raw: string): string | undefined {
  const typed = typedCode(raw);
  if (typed.length < CODE_MIN) return `A code here is ${CODE_MIN} or more characters; type a shorter one on the page yourself.`;
  if (typed.length > CODE_MAX) return `A code is at most ${CODE_MAX} characters.`;
  if (!/^[A-Za-z0-9-]+$/.test(typed)) return "A code is letters, digits and dashes.";
  return undefined;
}
