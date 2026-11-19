import { HIDDEN_VALUE } from "./snapshot.js";

/**
 * A page a secret was filled into, until its document changes: which fields
 * hold one, in which frame, and the values themselves, so what KOS reads
 * back from the page (its text, its outline, its title, a dialog) and the
 * pictures it takes of it show none of them, even where the page echoes
 * what was typed. The values live here only as long as the document does.
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
}

export interface Taint {
  /** The main frame's document it holds for. */
  loader: string;
  /** Tainted fields, by backend node, with the frame each is in. */
  nodes: Map<number, string>;
  values: FilledValue[];
}

/** Shorter than this, a value is not looked for in text: two digits would mask half a page. */
const ECHO_MIN = 3;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pattern a value is found by in text: a number by its digits with a space, dot or dash allowed between any two. */
function patternOf(value: FilledValue): RegExp | undefined {
  const text = value.digits ? value.text.replace(/\D/g, "") : value.text;
  if (text.length < ECHO_MIN) return undefined;
  return new RegExp(value.digits ? text.split("").map(escape).join("[\\s.\\-]?") : escape(text), "g");
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
