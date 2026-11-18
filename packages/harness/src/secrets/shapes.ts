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
 * 13 to 19 digits, up to three separators between any two, standing alone:
 * not after a letter, a digit or an underscore, nor a digit and separators
 * (a longer number or an id), and not before them either.
 */
const CARD = new RegExp(
  `(?<![A-Za-z0-9_])(?<![0-9]${CARD_SEP}{1,3})\\d(?:${CARD_SEP}{0,3}\\d){12,18}(?![A-Za-z0-9_])(?!${CARD_SEP}{1,3}[0-9])`,
  "g",
);

/** A bare JSON number: after `:`, `[` or `,` and before `,`, `}` or `]`, outside quotes. */
const JSON_BEFORE = /[:[,]\s*$/;
const JSON_AFTER = /^\s*[,}\]]/;

/**
 * Whether a digit run is worth masking as a card. Unseparated, only 14 to
 * 16 digits: 13 is a millisecond timestamp, 17 and more a snowflake or an
 * id. A bare JSON number is data, never a card.
 */
function cardLike(run: string, digits: string, before: string, after: string): boolean {
  if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return false;
  if (run === digits) {
    if (digits.length < 14 || digits.length > 16) return false;
    if (JSON_BEFORE.test(before) && JSON_AFTER.test(after)) return false;
  }
  return true;
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

/** The longest a shape match runs, for a stream to hold back. */
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
    .replace(CARD, (run: string, at: number, whole: string) => {
      const digits = run.replace(/%20|%[cC]2%[aA]0/g, "").replace(/\D/g, "");
      if (!cardLike(run, digits, whole.slice(Math.max(0, at - 8), at), whole.slice(at + run.length, at + run.length + 8))) return run;
      count("card");
      return `[secret card ••${digits.slice(-4)}]`;
    })
    .replace(KEY, () => {
      count("key");
      return "[secret key]";
    });
  return { text: out, hits };
}
