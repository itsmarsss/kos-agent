/**
 * Secrets found by their shape alone, for while the vault is locked and its
 * values cannot be looked for exactly: a card number by the Luhn check, and
 * an API key by a prefix its issuer always gives it. It masks what looks
 * like a secret, so it can mask one that is not; that is the trade for
 * masking anything at all with the vault shut.
 */

/**
 * A separator between a card's digits: a space, a tab, a dash, a dot, a
 * plus, an underscore, a slash, a no-break space, or a URL-encoded space or
 * no-break space. Shared with the exact scanner (scrub.ts).
 */
export const CARD_SEP = "(?:[ \\t.\\-+_/\\u00a0]|%20|%[cC]2%[aA]0)";

/**
 * A run of digit groups with up to three separators between groups, not
 * begun after a letter, a digit or an underscore. The whole run is taken
 * (a card and the expiry or CVC pasted after it, a list marker before it),
 * then the card is looked for at its start or its end.
 */
const RUN = new RegExp(`(?<![A-Za-z0-9_])\\d+(?:${CARD_SEP}{1,3}\\d+)*`, "g");

/** The digit groups of a run, each with where it starts and ends; an encoded separator is not a group. */
function groupsOf(run: string): { start: number; end: number; digits: string }[] {
  const groups: { start: number; end: number; digits: string }[] = [];
  for (const m of run.matchAll(/%20|%[cC]2%[aA]0|(\d+)/g)) {
    if (m[1] !== undefined) groups.push({ start: m.index, end: m.index + m[1].length, digits: m[1] });
  }
  return groups;
}

/** A bare JSON number: after `:`, `[` or `,` and before `,`, `}` or `]`, outside quotes. */
const JSON_BEFORE = /[:[,]\s*$/;
const JSON_AFTER = /^\s*[,}\]]/;

const isCard = (digits: string): boolean => digits.length >= 13 && digits.length <= 19 && luhn(digits);

/**
 * Where in a run the card is, if one is: the longest leading or trailing
 * span of whole groups whose digits pass as a card. A run of one group is a
 * number on its own and is held to more: 14 to 16 digits (13 is a
 * millisecond timestamp, 17 and more a snowflake or an id) and nothing
 * after it that makes it part of an id.
 */
function cardIn(run: string, after: string): { start: number; end: number; digits: string } | undefined {
  const groups = groupsOf(run);
  if (groups.length === 1) {
    const only = groups[0]!;
    if (only.digits.length < 14 || only.digits.length > 16 || !luhn(only.digits) || /^[A-Za-z_]/.test(after)) return undefined;
    return only;
  }
  let best: { start: number; end: number; digits: string } | undefined;
  const consider = (from: number, to: number): void => {
    const digits = groups.slice(from, to).map((g) => g.digits).join("");
    if (isCard(digits) && (!best || digits.length > best.digits.length)) best = { start: groups[from]!.start, end: groups[to - 1]!.end, digits };
  };
  for (let to = 1; to <= groups.length; to++) consider(0, to);
  for (let from = groups.length - 1; from > 0; from--) consider(from, groups.length);
  return best;
}

/** Keys by the prefixes their issuers give them, with enough after to be a key and not the word. */
const KEY = new RegExp(
  [
    "sk_live_[A-Za-z0-9]{8,}",
    "sk_test_[A-Za-z0-9]{8,}",
    "sk-[A-Za-z0-9_-]{16,}",
    "ghp_[A-Za-z0-9]{20,}",
    "gho_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "xox[a-z]-[A-Za-z0-9-]{10,}",
    "AKIA[0-9A-Z]{16}",
    "AIza[0-9A-Za-z_-]{35}",
    "glpat-[A-Za-z0-9_-]{20,}",
  ]
    .map((p) => `(?<![A-Za-z0-9_-])${p}`)
    .join("|"),
  "g",
);

/** The longest a card's span runs (19 digits, three separators of up to six characters between each two), for a stream to hold back. */
export const SHAPE_REACH = 19 + 18 * 18;

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** `text` with every card-shaped and key-shaped run masked, and how many of each. */
export function scrubShapes(text: string): { text: string; hits: Map<string, number> } {
  const hits = new Map<string, number>();
  const count = (name: string): void => void hits.set(name, (hits.get(name) ?? 0) + 1);
  const out = text
    .replace(RUN, (run: string, at: number, whole: string) => {
      const after = whole.slice(at + run.length, at + run.length + 8);
      const card = cardIn(run, after);
      if (!card) return run;
      count("card");
      const label = `[secret card ••${card.digits.slice(-4)}]`;
      // A card written as a bare JSON number becomes a JSON string, so what holds it still parses.
      const bare = card.start === 0 && card.end === run.length && JSON_BEFORE.test(whole.slice(Math.max(0, at - 8), at)) && JSON_AFTER.test(after);
      return `${run.slice(0, card.start)}${bare ? JSON.stringify(label) : label}${run.slice(card.end)}`;
    })
    .replace(KEY, () => {
      count("key");
      return "[secret key]";
    });
  return { text: out, hits };
}
