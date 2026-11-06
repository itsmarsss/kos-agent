/**
 * Whether a claim says only what the owner said.
 *
 * A claim is worded by the model ("The owner is vegetarian"), so it cannot be
 * matched to the owner's words whole. Its distinctive words can: the ones
 * left once the words any claim is built from (articles, pronouns, the owner
 * as subject, "prefers") are dropped. Every one of those must be in what the
 * owner said, or the claim says something the owner did not.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "into", "about",
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had", "do", "does", "did",
  "i", "im", "me", "my", "mine", "we", "our", "you", "your", "he", "she", "they", "them", "their", "his", "her", "it", "its",
  "this", "that", "these", "those", "so", "very", "just", "also", "should", "would", "will", "can", "could",
  "owner", "owners", "user", "users", "prefer", "prefers", "preference", "preferred", "like", "likes", "want", "wants",
  "please", "always",
]);

/** A word's plain form, so "peanut" and "peanuts" agree. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The claim's distinctive words, each found in what was said. */
export function groundedIn(claim: string, said: string): boolean {
  const distinctive = words(claim).filter((w) => !STOPWORDS.has(w)).map(stem);
  if (distinctive.length === 0) return false;
  const heard = new Set(words(said).map(stem));
  return distinctive.every((w) => heard.has(w));
}
