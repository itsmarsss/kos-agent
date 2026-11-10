/** Paths, references and file names: "not" in notes/ is no answer. */
const PATHS = /\S*(?:\/|@|\.\w)\S*/g;
/** Words that say it was not done, or that the thing is still there. */
const NO = /\b\w+n't\b|\bnot\b|declin|denied|\bkeep|kept|leav|left|\bstays?\b|untouched|\bstill\b/i;
/** Words that say it is still waiting, once "nothing is pending" and its like are set aside. */
const NOTHING_WAITING = /\b(?:nothing|no longer|not)\s+(?:is\s+|'s\s+)?(?:waiting|pending)\b/gi;
const WAITING = /\b(?:waiting|pending)\b/i;

/** Whether a reply tells the owner a thing was not done, and does not say it is still waiting. */
export function saysNotDone(reply) {
  const words = reply.replace(/’/g, "'").replace(PATHS, "");
  return NO.test(words) && !WAITING.test(words.replace(NOTHING_WAITING, ""));
}
