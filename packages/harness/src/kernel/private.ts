/**
 * Anything in a message that is nobody's business but the owner's, taken out
 * before the words become a chat's title.
 *
 * A title is shown on every surface, a shared Discord thread among them, and
 * a chat's first words are sent to the cheap route to name it, which may be
 * another provider than the turn's. A key or an address is never what a chat
 * is about, so neither the placeholder, the model's prompt nor a fallback
 * title carries one.
 */
const PRIVATE: RegExp[] = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  // The value after a word that says one follows: "password: x", "token=x", "my password is x".
  /\b(?:password|passwd|pwd|passcode|secret|token|api[_ -]?key|apikey)\b(?:\s+(?:is|was)\b)?\s*[:=]?\s*\S+/gi,
  /\bBearer\s+\S+/gi,
  /\b(?:sk|pk|rk)-[\w-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abprs]-[\w-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{30,}/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  // A long run of letters and digits mixed is a key or a token, not a word.
  /\b(?=[\w+/=-]*\d)(?=[\w+/=-]*[A-Za-z])[\w+/=-]{24,}/g,
];

export function withoutPrivate(text: string): string {
  return PRIVATE.reduce((out, pattern) => out.replace(pattern, " "), text).replace(/[ \t]+/g, " ").trim();
}
