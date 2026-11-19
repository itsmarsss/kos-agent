import { HIDDEN_VALUE } from "./snapshot.js";

/**
 * A tab a secret was filled into: which fields of the document hold one,
 * in which frame, until the document changes; and the values themselves,
 * for the tab's life, so what KOS reads back from it (its text, its
 * outline, its title, a dialog, a later page's address) and the pictures
 * it takes of it show none of them, even where a page echoes one.
 */

/** Where a secret may go in a form: what kind of field, as fillSecret checks it. */
export type SecretSlot =
  | "password"
  | "username"
  | "card-number"
  | "card-expiry"
  | "card-exp-month"
  | "card-exp-year"
  | "card-cvc"
  | "card-name"
  | "address-line1"
  | "address-line2"
  | "address-city"
  | "address-region"
  | "address-postal"
  | "address-country"
  | "token"
  | "text";

/** Slots whose value is a secret: their fields are tainted and their values masked. A username, a name or an address is filled and left be. */
const SECRET_SLOTS: ReadonlySet<SecretSlot> = new Set(["password", "card-number", "card-expiry", "card-exp-month", "card-exp-year", "card-cvc", "token", "text"]);

/** Slots matched by their digits, however a page spaces them. */
const DIGIT_SLOTS: ReadonlySet<SecretSlot> = new Set(["card-number", "card-cvc"]);

export function isSecretSlot(slot: SecretSlot): boolean {
  return SECRET_SLOTS.has(slot);
}

export function isDigitSlot(slot: SecretSlot): boolean {
  return DIGIT_SLOTS.has(slot);
}

export interface FilledValue {
  text: string;
  digits: boolean;
  /**
   * The origins it was filled on (the page's and the field's frame's): only
   * frames on one of them are sent its pattern to find it by. None for a
   * saved value, which is sent only to its own sites' frames.
   */
  origins?: string[];
}

/** A value filled kept in `values`: once, with every origin it was filled on. */
export function keepFilled(values: FilledValue[], value: FilledValue): void {
  const had = values.findIndex((v) => v.text === value.text);
  if (had < 0) values.push(value);
  else values[had] = { ...values[had]!, origins: [...new Set([...(values[had]!.origins ?? []), ...(value.origins ?? [])])] };
}

/** The fields of one document a secret is in: what refuses scripts, copies and selectors until the document changes. */
export interface Taint {
  /** The main frame's document it holds for. */
  loader: string;
  /** Tainted fields, by backend node, with the frame each is in. */
  nodes: Map<number, string>;
}

/**
 * What one tab holds of the secrets filled into it, for the tab's life: kept
 * by whoever outlives its Page (BrowserLive, by tab), so the Page made again
 * after a detach holds the page as the one before it did.
 */
export interface TabSecrets {
  /** The fields of the document a secret is in now, until it changes. */
  taint?: Taint;
  /** Addresses (less their fragment) of documents a secret was filled into: history coming back to one may restore it. */
  readonly urls: Set<string>;
  /** Every value filled in the tab: a later page may echo one. */
  readonly filled: FilledValue[];
}

/** A tab's secrets before any is filled. */
export function noSecrets(): TabSecrets {
  return { urls: new Set(), filled: [] };
}

/**
 * What a conversation's tabs share about the secrets KOS filled: a popup can
 * read its opener, and any tab may echo what another sent, so every value
 * filled in any of them is masked in all, and while one holds a secret no
 * script runs in any.
 */
export interface Kin {
  /** Every value filled in any of the tabs, for their life. */
  readonly values: FilledValue[];
  /** Whether any of the tabs holds a secret KOS filled in its page now. */
  holding(): boolean;
}

/** Shorter than this, a value is not looked for in text: two digits would mask half a page. */
export const ECHO_MIN = 3;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A character of a value however a page may say it back: as itself, percent
 * encoded in either case of hex (as encodeURIComponent, a form or the
 * browser's own address bar encode it, each leaving some characters be), a
 * space as + too, and a quote or a backslash as JSON escapes it.
 */
function charForms(c: string): string {
  if (/[A-Za-z0-9]/.test(c)) return c;
  const hex = (b: number): string => `%${Array.from(b.toString(16).padStart(2, "0"), (d) => `[${d.toUpperCase()}${d}]`).join("")}`;
  // The JSON escape first: tried before the bare character, it is not cut in half.
  const forms = [...(c === '"' || c === "\\" ? [escape(`\\${c}`)] : []), escape(c), Array.from(new TextEncoder().encode(c), hex).join(""), ...(c === " " ? ["\\+"] : [])];
  return `(?:${forms.join("|")})`;
}

/**
 * The patterns (RegExp sources) a value is found by in text: a number by its
 * digits with a space, dot or dash allowed between any two; anything else
 * each character in every form a page may say it back in, so an address
 * or a script's JSON that carries it is found too. None shorter than `min`.
 */
export function echoPatterns(values: readonly FilledValue[], min = ECHO_MIN): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = value.digits ? value.text.replace(/\D/g, "") : value.text;
    if (text.length < min) continue;
    out.push(value.digits ? text.split("").map(escape).join("[\\s.\\-]?") : Array.from(text, charForms).join(""));
  }
  return out;
}

/** Each value's pattern, made once: text is cleaned line by line against every saved secret. */
const compiled = new WeakMap<FilledValue, RegExp | null>();

function patternOf(value: FilledValue): RegExp | null {
  let pattern = compiled.get(value);
  if (pattern === undefined) {
    const [source] = echoPatterns([value]);
    pattern = source === undefined ? null : new RegExp(source, "g");
    compiled.set(value, pattern);
  }
  return pattern;
}

/** `text` with every filled value said as hidden. */
export function unechoed(text: string, values: readonly FilledValue[]): string {
  let out = text;
  for (const value of values) {
    const pattern = patternOf(value);
    if (pattern) out = out.replace(pattern, HIDDEN_VALUE);
  }
  return out;
}
