import { SECRET_FIELDS, SECRET_KINDS, SECRET_REQUIRED, type SecretBilling, type SecretFieldName, type SecretKind, type SecretPolicy, type SecretUse, type SecretValues } from "@kos/shared";

import type { ScanMode, Watched } from "./scrub.js";

/**
 * What a secret record may hold, checked before it is sealed: its label,
 * its values by kind, where it may be used and how it asks (docs/secrets.md).
 * A bad field is refused with a reason the owner can act on; the reason
 * never repeats a value.
 */

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

export const LABEL_MAX = 80;
const VALUE_MAX = 4096;
const NOTE_MAX = 32_768;
const BILLING_KEYS: readonly (keyof SecretBilling)[] = ["line1", "line2", "city", "region", "postal", "country"];

/** A value the scrubber looks for: `<handle>.<field>`, the value, and how. */
export type ScannedValue = Watched;

export function isKind(kind: unknown): kind is SecretKind {
  return typeof kind === "string" && (SECRET_KINDS as readonly string[]).includes(kind);
}

export function labelOf(label: unknown): string {
  const text = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "";
  if (!text) throw new RecordError("a secret needs a label");
  if (text.length > LABEL_MAX) throw new RecordError(`a label is at most ${LABEL_MAX} characters`);
  return text;
}

/** The label as a handle's start: lowercase words joined by dashes, at most 24 characters. */
export function slugOf(label: string): string {
  const slug = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return slug || "secret";
}

/**
 * The values a kind holds, merged over `before` for an edit: a field left
 * out or empty keeps what it had. A card number is kept as its digits.
 */
export function checkValues(kind: SecretKind, given: unknown, before: SecretValues | undefined): SecretValues {
  if (!isKind(kind)) throw new RecordError("kind is one of login, card, apikey, note");
  if (given !== undefined && (given === null || typeof given !== "object" || Array.isArray(given))) throw new RecordError("values is an object of fields");
  const allowed = SECRET_FIELDS[kind];
  const out: SecretValues = { ...before };
  for (const [field, value] of Object.entries((given ?? {}) as Record<string, unknown>)) {
    if (!(allowed as readonly string[]).includes(field)) throw new RecordError(`a ${kind} has no field ${field}; it has ${allowed.join(", ")}`);
    if (value === undefined || value === null || value === "") continue;
    if (field === "billing") {
      out.billing = { ...before?.billing, ...checkBilling(value) };
      continue;
    }
    if (typeof value !== "string") throw new RecordError(`${field} is text`);
    const max = field === "text" ? NOTE_MAX : VALUE_MAX;
    if (value.length > max) throw new RecordError(`${field} is at most ${max} characters`);
    out[field as Exclude<SecretFieldName, "billing">] = field === "number" ? cardNumber(value) : field === "expiry" ? expiry(value) : field === "cvc" ? cvc(value) : value;
  }
  for (const field of SECRET_REQUIRED[kind]) {
    if (out[field] === undefined) throw new RecordError(`a ${kind} needs its ${field}`);
  }
  return out;
}

function checkBilling(value: unknown): SecretBilling {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RecordError("billing is an address object");
  const out: SecretBilling = {};
  for (const [key, part] of Object.entries(value as Record<string, unknown>)) {
    if (!(BILLING_KEYS as readonly string[]).includes(key)) throw new RecordError(`billing has no ${key}; it has ${BILLING_KEYS.join(", ")}`);
    if (part === undefined || part === null || part === "") continue;
    if (typeof part !== "string" || part.length > 200) throw new RecordError(`billing ${key} is text of at most 200 characters`);
    out[key as keyof SecretBilling] = part;
  }
  return out;
}

function cardNumber(value: string): string {
  if (!/^[\d .-]+$/.test(value)) throw new RecordError("a card number is digits, spaces or dashes");
  const digits = value.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) throw new RecordError("a card number has 12 to 19 digits");
  return digits;
}

function expiry(value: string): string {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(value);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) throw new RecordError("an expiry is MM/YY or MM/YYYY");
  return `${m[1]!.padStart(2, "0")}/${m[2]!.slice(-2)}`;
}

function cvc(value: string): string {
  if (!/^\d{3,4}$/.test(value.trim())) throw new RecordError("a CVC is 3 or 4 digits");
  return value.trim();
}

/** A site a secret may be filled on: https, an exact host or `*.` a domain, and an optional port; http only for localhost. */
export function checkOrigin(origin: unknown): string {
  if (typeof origin !== "string") throw new RecordError("an origin is text such as https://example.com");
  const text = origin.trim().toLowerCase().replace(/\/+$/, "");
  const m = /^(https|http):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/.exec(text);
  if (!m) throw new RecordError(`${JSON.stringify(origin.slice(0, 100))} is not an origin such as https://example.com`);
  const [, scheme, wild, host, port] = m;
  if (scheme === "http" && (host !== "localhost" || wild)) throw new RecordError("only http://localhost may be plain http; every other site is https");
  if (wild && !host!.includes(".")) throw new RecordError("a wildcard covers the subdomains of a domain, such as https://*.example.com");
  if (port && (Number(port) < 1 || Number(port) > 65_535)) throw new RecordError(`${port} is not a port`);
  return text;
}

function checkHost(host: unknown): string {
  if (typeof host !== "string") throw new RecordError("a host is text such as api.example.com");
  const text = host.trim().toLowerCase();
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(text)) throw new RecordError(`${JSON.stringify(host.slice(0, 100))} is not a host such as api.example.com`);
  return text;
}

function checkApp(app: unknown): string {
  if (typeof app !== "string" || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app.trim())) throw new RecordError("an app is a bundle id such as com.example.app");
  return app.trim();
}

const listOf = <T>(value: unknown, check: (v: unknown) => T, what: string): T[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RecordError(`${what} is a list`);
  if (value.length > 100) throw new RecordError(`${what} holds at most 100`);
  return [...new Set(value.map(check))];
};

/**
 * A grant's key for a secret typed on a Mac (secrets.type): the app by bundle
 * id, and the page's origin for a field on a page in a browser. Kept beside
 * the sites' grants, which are origins.
 */
export function appGrant(bundle: string, origin?: string): string {
  return `app:${bundle}${origin ? `@${origin}` : ""}`;
}

/** Whether a grant's key may be kept for a secret used as `use` says: a site it may be filled on, or an app it may be typed into (on a site it may be filled on). */
export function grantAllowed(key: string, use: SecretUse): boolean {
  const app = /^app:([^@]+)(?:@(.+))?$/.exec(key);
  if (!app) return originAllowed(key, use.web.origins);
  return use.apps.includes(app[1]!) && (app[2] === undefined || originAllowed(app[2], use.web.origins));
}

/** Whether `origin` is one of `allowed`, an entry `https://*.example.com` covering its subdomains. */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const star = entry.indexOf("://*.");
    if (star < 0) return entry === origin;
    const scheme = entry.slice(0, star + 3);
    return origin.startsWith(scheme) && origin.slice(scheme.length).endsWith(entry.slice(star + 4)) && origin.length > entry.length - 1;
  });
}

export function checkUse(given: unknown): SecretUse {
  if (given === undefined || given === null) return { web: { origins: [], frames: [] }, apps: [], http: { hosts: [] } };
  if (typeof given !== "object" || Array.isArray(given)) throw new RecordError("use is an object of web, apps and http");
  const u = given as { web?: { origins?: unknown; frames?: unknown }; apps?: unknown; http?: { hosts?: unknown; as?: unknown } };
  const as = u.http?.as;
  if (as !== undefined && as !== null && as !== "bearer" && as !== "basic") throw new RecordError("http.as is bearer or basic");
  return {
    web: { origins: listOf(u.web?.origins, checkOrigin, "web.origins"), frames: listOf(u.web?.frames, checkOrigin, "web.frames") },
    apps: listOf(u.apps, checkApp, "apps"),
    http: { hosts: listOf(u.http?.hosts, checkHost, "http.hosts"), ...(as ? { as } : {}) },
  };
}

/** How a secret asks. Grants are never set here: only an approval adds one, and only the owner takes one back. */
export function checkPolicy(given: unknown, before: SecretPolicy | undefined): SecretPolicy {
  const base: SecretPolicy = before ?? { ask: "always", unattended: false, chats: null, grants: [] };
  if (given === undefined || given === null) return base;
  if (typeof given !== "object" || Array.isArray(given)) throw new RecordError("policy is an object of ask, unattended and chats");
  const p = given as { ask?: unknown; unattended?: unknown; chats?: unknown };
  if (p.ask !== undefined && p.ask !== "always" && p.ask !== "turn" && p.ask !== "site") throw new RecordError("policy.ask is always, turn or site");
  if (p.unattended !== undefined && typeof p.unattended !== "boolean") throw new RecordError("policy.unattended is true or false");
  const chats =
    p.chats === undefined
      ? base.chats
      : p.chats === null
        ? null
        : listOf(p.chats, (c) => {
            if (typeof c !== "string" || !c.trim() || c.length > 160) throw new RecordError("policy.chats lists chat ids");
            return c.trim();
          }, "policy.chats");
  return {
    ask: (p.ask as SecretPolicy["ask"] | undefined) ?? base.ask,
    unattended: (p.unattended as boolean | undefined) ?? base.unattended,
    chats,
    grants: base.grants,
  };
}

/** What the list shows of a secret: never enough of a value to matter. */
export function hintOf(kind: SecretKind, values: SecretValues): string {
  switch (kind) {
    case "card":
      return `•••• ${values.number?.slice(-4) ?? ""}`.trim();
    case "apikey":
      return values.token && values.token.length > 12 ? `••••${values.token.slice(-4)}` : "••••";
    case "login":
      return "••••••••";
    case "note": {
      const lines = values.text?.split("\n").length ?? 0;
      return `${lines} ${lines === 1 ? "line" : "lines"}`;
    }
  }
}

/** The lines of a note long enough to stand for it alone. */
const NOTE_LINE_MIN = 8;

/**
 * Every value of a record the scrubber looks for, and how: a password, a
 * token and a note as they are and encoded, each long line of a note on its
 * own, a card number by its digits. A username, an expiry, a CVC, a name
 * and an address are not looked for: they are short or not secret on their
 * own, and would mask ordinary text.
 */
export function scannedOf(record: { handle: string; kind: SecretKind; values: SecretValues }): ScannedValue[] {
  const { handle, values } = record;
  const out: ScannedValue[] = [];
  const add = (field: SecretFieldName, value: string | undefined, mode: ScanMode = "exact"): void => {
    if (value) out.push([`${handle}.${field}`, value, mode]);
  };
  switch (record.kind) {
    case "login":
      add("password", values.password);
      break;
    case "apikey":
      add("token", values.token);
      break;
    case "card":
      add("number", values.number, "digits");
      break;
    case "note":
      add("text", values.text);
      for (const line of values.text?.split("\n") ?? []) if (line.trim().length >= NOTE_LINE_MIN && line !== values.text) add("text", line.trim());
      break;
  }
  return out;
}
