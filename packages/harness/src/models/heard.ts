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

/** The owner's line as a turn's mark made it: eight hex digits, as randomBytes(4) writes them. */
const OLD_OWNER_LINE = /\n\n\[the owner, while you work · ([0-9a-f]{8})\]\n/g;

/**
 * A result kept before the words had a field of their own, and the owner's
 * words appended to it then: only under a mark a turn could have made, and
 * split only at lines with that same mark. The owner's words came last, so
 * the mark is the last line's: a line the page wrote above them stays its own.
 */
export function splitOwnerWords(content: string): { content: string; said: OwnerWords[] } {
  const last = [...content.matchAll(OLD_OWNER_LINE)].at(-1);
  if (!last) return { content, said: [] };
  const mark = last[1]!;
  const start = content.indexOf(`\n\n${OWNER_LINE}${mark}]\n`);
  const said = content
    .slice(start)
    .split(`\n\n${OWNER_LINE}${mark}]\n`)
    .flatMap((w) => {
      const text = (w.split(`\n\n${WHERE_LINE}${mark}]\n`)[0] ?? "").trim();
      return text ? [{ text }] : [];
    });
  return { content: content.slice(0, start), said };
}

/** A result and the owner's words with it, whether kept beside it or, in an older chat, inside it. */
export function heardWith(block: { content: string; heard?: HeardWords }): { content: string; said: OwnerWords[] } {
  return block.heard ? { content: block.content, said: block.heard.words } : splitOwnerWords(block.content);
}

/** The owner's words heard with a result, as lines in their own voice for a model rereading the chat. */
export function ownerLines(block: { content: string; heard?: HeardWords }): string[] {
  return heardWith(block).said.map((w) => `Owner, while you worked: ${w.text}`);
}
