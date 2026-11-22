/**
 * One check for every name the owner gives a thing: a project, a schedule,
 * a secret, a blob, an artifact. The server refuses with it and the forms
 * check with it as the owner types, so the two always say the same words,
 * and a refusal is never the store's own ("UNIQUE constraint failed").
 */

/** The longest name anything takes: long enough to say what it is, short enough for a card's title. */
export const NAME_MAX = 80;

/** What can be wrong with a name. */
export type NameProblem = "empty" | "too_long" | "invalid" | "taken";

/** A name refused: which way, and the sentence the owner reads beside the field. */
export interface NameCheck {
  problem: NameProblem;
  message: string;
}

export interface NameRules {
  /** What it names, as the owner says it: "project", "schedule", "secret". */
  noun: string;
  /** The names already in use, compared trimmed and without case. */
  taken?: Iterable<string>;
  /** Only letters, digits and dashes, for a name that is also a folder (a blob's). */
  plain?: boolean;
  /** Another limit than NAME_MAX, where the store keeps its own (an artifact's title). */
  max?: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const PLAIN = /^[a-z0-9][a-z0-9_-]*$/i;
const WORD = /[\p{L}\p{N}]/u;

/** The same name as another, as the owner would see it: trimmed, any case. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/** What is wrong with a name, or null when it will do. */
export function checkName(raw: string, rules: NameRules): NameCheck | null {
  const name = raw.trim();
  const max = rules.max ?? NAME_MAX;
  const noun = rules.noun;
  if (!name) return { problem: "empty", message: `Give the ${noun} a name.` };
  if (name.length > max) return { problem: "too_long", message: `Keep it to ${max} characters; this is ${name.length}.` };
  if (rules.plain && !PLAIN.test(name)) return { problem: "invalid", message: "Use letters, digits and dashes only, starting with a letter or digit." };
  if (CONTROL.test(name)) return { problem: "invalid", message: "A name can't hold a line break or a tab." };
  if (!WORD.test(name)) return { problem: "invalid", message: "Put at least one letter or digit in it." };
  for (const other of rules.taken ?? []) {
    if (sameName(other, name)) return { problem: "taken", message: `There is already a ${noun} called “${other.trim()}”. Pick another name.` };
  }
  return null;
}

/** A refusal's body on the wire: the sentence, the field it is about and how it is wrong. */
export interface FieldRefusal {
  error: string;
  field: string;
  problem: NameProblem;
}

/** The body a route answers a refused name with. */
export function nameRefusal(check: NameCheck, field = "name"): FieldRefusal {
  return { error: check.message, field, problem: check.problem };
}

/** A name refused by the store's own primitive, carried up to the route that answers with it. */
export class NameError extends Error {
  constructor(readonly check: NameCheck) {
    super(check.message);
    this.name = "NameError";
  }
}

/** Throws a NameError when the name will not do; the name, trimmed, when it will. */
export function assertName(raw: string, rules: NameRules): string {
  const check = checkName(raw, rules);
  if (check) throw new NameError(check);
  return raw.trim();
}
