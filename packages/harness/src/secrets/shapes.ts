/**
 * Secrets found by their shape alone, for while the vault is locked and its
 * values cannot be looked for exactly: a card number by the Luhn check, and
 * an API key by a prefix its issuer always gives it. It masks what looks
 * like a secret, so it can mask one that is not; that is the trade for
 * masking anything at all with the vault shut.
 */

/** A separator between a card's digits: a space, a dash, a dot, a no-break space, or a URL-encoded space. */
const SEP = "(?:[ .\\-\\u00a0]|%20)";

/** 13 to 19 digits, up to two separators between any two, not inside a longer number. */
const CARD = new RegExp(`(?<![\\d])\\d(?:${SEP}{0,2}\\d){12,18}(?![\\d])`, "g");

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
export const SHAPE_REACH = 19 + 18 * 6;

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
    .replace(CARD, (run) => {
      const digits = run.replace(/%20/g, "").replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return run;
      count("card");
      return `[secret card ••${digits.slice(-4)}]`;
    })
    .replace(KEY, () => {
      count("key");
      return "[secret key]";
    });
  return { text: out, hits };
}
