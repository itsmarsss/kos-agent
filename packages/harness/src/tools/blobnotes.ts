/**
 * What the chat that asked a blob for help is shown of it.
 *
 * The blob's work is the blob's thread; the chat that asked keeps two short
 * marks of it: a line where it asked, linking to that thread, and a card
 * when the blob answers. The answer itself stays in the blob's thread, so
 * the card is a summary of it, never the reply pasted whole.
 */

const TASK_MAX = 90;
const ANSWER_MAX = 280;

/** Cut at a word near `max`, with an ellipsis when anything was cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * The task as the rest of "Asked Follow ups to …": its first sentence, one
 * line, its opening letter lowered unless the word is a name or an acronym.
 */
export function taskSummary(task: string): string {
  const line = task.replace(/\s+/g, " ").trim();
  const sentence = (/^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line).replace(/[.!?]+$/, "");
  const shouted = /^[A-Z]{2}|^I\b/.test(sentence);
  const lowered = shouted ? sentence : sentence.charAt(0).toLowerCase() + sentence.slice(1);
  return clip(lowered, TASK_MAX);
}

/**
 * The gist of a reply: its prose, without code or typed blocks, on one
 * line. A fence would close the card's own, and the full reply is a tap away.
 */
export function replySummary(reply: string): string {
  const prose = reply
    .replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1`*[ \t]*$/gm, " ")
    // A fence left open runs to the end, as the reader draws it.
    .replace(/`{3,}[\s\S]*$/, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(prose || "Done, with nothing to say.", ANSWER_MAX);
}

/** The line in the asking chat: who was asked, to do what, and the way to its thread. */
export function askedLine(blobTitle: string, threadId: string, task: string): string {
  return `Asked ${blobTitle} to ${taskSummary(task)} · Open @chat:[${threadId}]`;
}

/** The card in the asking chat when the blob is done, or could not be. */
export function answerCard(blobTitle: string, threadId: string, task: string, outcome: { reply: string } | { error: string }): string {
  const failed = "error" in outcome;
  return [
    "```kos:card",
    `title: ${blobTitle} ${failed ? "could not finish" : "answered"}`,
    `asked: ${taskSummary(task)}`,
    `thread: @chat:[${threadId}]`,
    "---",
    failed ? `It failed: ${clip(outcome.error.replace(/\s+/g, " ").trim(), ANSWER_MAX)}` : replySummary(outcome.reply),
    "```",
  ].join("\n");
}
