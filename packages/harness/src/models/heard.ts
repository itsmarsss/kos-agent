/**
 * The owner's words said while a turn runs, as they reach it: after the
 * result of the turn's next tool call, under a line carrying a mark the
 * turn was told and nothing outside it knows. A page or a file can write
 * anything into a result, but not that mark, so it cannot pass for the
 * owner speaking.
 *
 * Kept beside the result rather than inside it: a result is capped when
 * history is kept, and words appended to a long one were cut away with its
 * tail. They join the result's text only on the way to a model.
 */

/** Words the owner said while a turn ran: where they were, and the surface, when there is one to say. */
export interface OwnerWords {
  text: string;
  /** Where the owner was when they said them (the tab or app beside a device's chat): not their words. */
  where?: string;
  /** The surface they were said on, when not the dashboard: for the reader, not the model. */
  via?: string;
}

/** What a tool's result carried in with it, under the turn's mark. */
export interface HeardWords {
  mark: string;
  words: OwnerWords[];
}

const OWNER_LINE = "[the owner, while you work · ";
const WHERE_LINE = "[where the owner said that · ";

/** The owner's words as the model reads them, each with where it was said when the surface says so. */
export function ownerWords(mark: string, words: OwnerWords[]): string {
  return words.map((w) => `\n\n${OWNER_LINE}${mark}]\n${w.text}${w.where ? `\n\n${WHERE_LINE}${mark}]\n${w.where}` : ""}`).join("");
}

/** A result as a model reads it: its own text, then the owner's words that rode in with it. */
export function resultText(block: { content: string; heard?: HeardWords }): string {
  return block.heard ? `${block.content}${ownerWords(block.heard.mark, block.heard.words)}` : block.content;
}

/**
 * A tool's own text, unable to pass for the owner's line: a page or a file
 * that writes it is quoted, so no reader draws it as the owner speaking.
 */
export function defang(content: string): string {
  return content.replaceAll(`\n\n${OWNER_LINE}`, `\n\n[quoted] ${OWNER_LINE}`);
}

/**
 * A result kept before the words had a field of their own, and the owner's
 * words appended to it then.
 */
export function splitOwnerWords(content: string): { content: string; said: OwnerWords[] } {
  const at = content.indexOf(`\n\n${OWNER_LINE}`);
  if (at === -1) return { content, said: [] };
  const said = content
    .slice(at)
    .split(/\n\n\[the owner, while you work · [0-9a-z]+\]\n/)
    .flatMap((w) => {
      const text = (w.split(/\n\n\[where the owner said that · [0-9a-z]+\]\n/)[0] ?? "").trim();
      return text ? [{ text }] : [];
    });
  return { content: content.slice(0, at), said };
}

/** A result and the owner's words with it, whether kept beside it or, in an older chat, inside it. */
export function heardWith(block: { content: string; heard?: HeardWords }): { content: string; said: OwnerWords[] } {
  return block.heard ? { content: block.content, said: block.heard.words } : splitOwnerWords(block.content);
}
