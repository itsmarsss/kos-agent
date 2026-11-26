/**
 * Which of a turn's words are its reply, the same on both engines.
 *
 * The reply is what the model says after its last tool call; what it says
 * before a call narrates that step. Two shapes break the plain rule: the
 * answer written first and then saved or posted (a memory note, a notify),
 * where nothing or one line follows the last call. There the answer is the
 * words before that trailing bookkeeping, not the line after it.
 */

/**
 * Calls that only write down or deliver what was already said: a save, a
 * task, a schedule, a post. Reads (memory.recall, tasks.list, cron.list) and
 * actions (cron.run) are not: what follows them answers what they found.
 */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  "memory.remember",
  "memory.observe",
  "memory.forget",
  "memory.merge",
  "memory.mark_read",
  "tasks.add",
  "tasks.complete",
  "tasks.create_list",
  "cron.schedule",
  "cron.remove",
  "notify",
  "discord.react",
]);

export function isBookkeeping(tool: string): boolean {
  return BOOKKEEPING.has(tool);
}

/** A final line this short after bookkeeping is a coda ("Buttons sent above."), not the answer. */
const CODA_MAX = 120;
/** Words this long before bookkeeping are an answer, not a line about the next step. */
const ANSWER_MIN = 200;

/** One call of the turn, in order, with the words said just before it (on the first call after them). */
export interface SaidCall {
  name: string;
  said?: string;
}

/** How a turn ended: on its own, or cut short by a Stop, the step limit or an error. */
export type TurnEnd = "done" | "cut";

export interface TurnReply {
  text: string;
  /** The call whose narration became the reply, by its place in the turn: no longer that step's to keep. */
  from?: number;
}

/** The reply to a turn of `calls` that ended (`end`) with `final` said after the last of them. */
export function replyFrom(calls: readonly SaidCall[], final: string, end: TurnEnd): TurnReply {
  const last = final.trim();
  // The calls at the end that only saved or posted.
  let run = calls.length;
  while (run > 0 && isBookkeeping(calls[run - 1]!.name)) run -= 1;
  if (!last) {
    // Only a turn that ended on its own was done saving its answer; a cut-short one says why it stopped instead.
    const said = end === "done" && run < calls.length ? calls[run]!.said?.trim() : undefined;
    return said && said.length > ANSWER_MIN ? { text: said, from: run } : { text: "" };
  }
  if (last.length < CODA_MAX) {
    let answer: number | undefined;
    for (let i = run; i < calls.length; i += 1) {
      const said = calls[i]!.said?.trim() ?? "";
      if (said.length > ANSWER_MIN && said.length > (answer === undefined ? 0 : calls[answer]!.said!.trim().length)) answer = i;
    }
    if (answer !== undefined) return { text: `${calls[answer]!.said!.trim()}\n\n${last}`, from: answer };
  }
  return { text: last };
}
