/**
 * How KOS speaks, everywhere.
 *
 * The model answered at length, in a voice full of em dashes and
 * preamble, on the dashboard and on Discord alike. The Discord style section
 * shaped replies there; nothing shaped them anywhere else. This is the house
 * voice for every surface, in front of the model on every turn, and a
 * rewrite for the one habit a rule does not break: the em dash.
 */

export const VOICE = [
  "## Voice",
  "Short, plain, done. Lead with the answer or the outcome. No preamble, no restating the ask, no sign-off, no narrating what you are about to do: the dashboard shows your tool calls.",
  "One idea per sentence. A simple ask gets one or two lines; a report stays under ten. Say what happened, not what you did to find out.",
  "Never an em dash. Write a comma, a colon, or a new sentence.",
  "Format for reading, not decoration: bullets only for three or more parallel things, one line each, never nested; a heading only when a reply has three or more distinct parts; bold at most one phrase, the thing not to miss; `code` for ids, paths, commands and exact values; a fenced block for anything column-shaped.",
  "Ids and paths exactly as tools gave them. A reference (@project:x, @approval:12, #channel) bare, never in code.",
  "After an approval or a tool result, one line: what happened and the result.",
  "Ask one question, at the end, only when you cannot proceed without it.",
].join("\n");

/** The dashes a rule does not stop: an em dash anywhere, an en dash used as one (spaced). */
const DASH = /[ \t]*(?:—|(?<=\S) – (?=\S)|–(?= )|(?<= )–)[ \t]*/g;

/**
 * Rewrite a reply's em dashes outside code, deterministically: at the start of
 * a line it was a bullet, at the end a full stop, after a comma or a colon
 * just the pause, anywhere else a comma. Code spans and fenced blocks are
 * the model's exactly, since a dash in them may be the program's.
 */
export function inHouseVoice(text: string): string {
  if (!/[—–]/.test(text)) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : replaceDashes(part)))
    .join("");
}

function replaceDashes(prose: string): string {
  return prose.replace(DASH, (match, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + match.length);
    const atLineStart = before === "" || before.endsWith("\n");
    if (atLineStart) return "- ";
    const atLineEnd = after === "" || after.startsWith("\n");
    if (atLineEnd) return /[.!?:,;]$/.test(before) ? "" : ".";
    if (/[,:;]$/.test(before)) return " ";
    return ", ";
  });
}
