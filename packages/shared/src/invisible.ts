/** Marks that turn text's direction around: an approval or a link that reads one way and does another. */
export const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

/** Every format character: the direction marks, zero-width spaces and joiners, the byte-order mark and the rest. */
const FORMAT = /\p{Cf}/gu;

/**
 * Text with each invisible format character shown as its code point,
 * "⟨U+202E⟩": in an approval, a character that reorders or hides what
 * follows must be seen, not obeyed.
 */
export function showInvisible(text: string): string {
  return text.replace(FORMAT, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
}
