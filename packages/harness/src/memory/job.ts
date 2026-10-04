import type { CronStore } from "../cron/store.js";

/**
 * Memory as KOS's own job.
 *
 * The fixed extractor is a floor: a cheap model behind a strict contract.
 * This is the ceiling: KOS itself, as a scheduled self-prompt, reading what
 * was said with memory.unread, keeping what matters with memory.remember
 * and its evidence, and marking the batch read. The brief is a prompt the
 * owner can read and edit on the Schedule page; the model is whatever the
 * job is routed to; the run is a turn in the job's own thread, so it can
 * be watched and argued with. The evidence contract is still the
 * harness's: a remember that cites events it was not shown is refused.
 */

export const MEMORY_JOB = "kos.memory";
export const MEMORY_JOB_SCHEDULE = "0 */6 * * *";

export const MEMORY_JOB_PROMPT = [
  "You are maintaining your own long-term memory about the owner. Be strict: memory is for",
  "what will still be true and useful months from now. Prefer keeping nothing over guessing.",
  "",
  "1. Call memory.unread. It gives you new conversation events with ids, and the claims already",
  "   remembered that might relate.",
  "2. Keep, with memory.remember and evidence (the ids of the events it came from): identities and",
  "   relationships, stated preferences, decisions, standing constraints, recurring arrangements,",
  "   tools and services the owner uses, and facts about a project. One claim per fact: two facts",
  "   in one message are two calls. Keys are short generic snake_case nouns (sister, employer,",
  "   timezone, city, coffee_order), never sentences. A key names the owner's own attribute; a fact",
  "   about someone else goes under that person (sister: Nadia, a nurse in Halifax), never under",
  "   the owner's city or job. When a related claim already covers the thing, use its exact key so",
  '   the new value replaces the old, even if you would name it differently. If a related claim already',
  '   says the same thing, keep nothing for it. Scope "project" for things about',
  '   the project the events belong to, "global" for the owner anywhere.',
  "   An event marked via a caller is the outside world's word: keep it only if it is plainly",
  "   about that caller's own work; it will be kept at external trust.",
  "3. Do not keep: questions, one-off requests, small talk, how the owner feels today, where they",
  "   are right now, battery or weather or traffic, plans that merely might happen, anything you",
  "   or the assistant inferred rather than the owner said, and never secrets, passwords, card",
  "   numbers or API keys. If a message is only such things, keep nothing from it.",
  "4. Call memory.mark_read with the cursor you were given. If remaining was above zero, go back",
  "   to step 1, up to five times.",
  "",
  "Finish with one short line listing the keys you called memory.remember for in this run, or the",
  "words \"nothing new\". Never say you kept something you did not call memory.remember for.",
].join("\n");

/** The memory job exists in every workspace, off until the owner switches it on. */
export function ensureDefaultMemoryCron(crons: CronStore): void {
  if (crons.list().some((j) => j.name === MEMORY_JOB)) return;
  crons.create({
    name: MEMORY_JOB,
    schedule: MEMORY_JOB_SCHEDULE,
    type: "self_prompt",
    prompt: MEMORY_JOB_PROMPT,
    // Reading and filing is the cheap route's job; the owner can move it.
    task: "cheap",
    enabled: false,
  });
}

export const DREAM_JOB = "kos.dream";
export const DREAM_JOB_SCHEDULE = "0 4 * * *";

export const DREAM_JOB_PROMPT = [
  "You are tidying your own long-term memory while the owner sleeps. Be conservative: a wrong",
  "merge loses a fact, a wrong archive hides one; when unsure, flag it for the owner instead.",
  "",
  "1. Call memory.review. It gives you pairs of claims that may be one thing or may disagree,",
  "   claims nobody has used for a long time, what pages exist, and which pages the owner edited.",
  "   For every edited page, call memory.import_page first: the owner's edits outrank everything",
  "   you believe, and they must be in memory before you tidy.",
  "2. For a pair that is plainly the same fact said twice, call memory.merge keeping the better",
  "   key (short, generic) and value. For a pair that plainly disagrees and the newer one is",
  "   clearly the correction, call memory.merge keeping the newer. For a disagreement you cannot",
  "   settle from the values alone, call memory.flag with kind contradiction and one line saying",
  "   why. For a project claim that is really about the owner everywhere, call memory.flag with",
  "   kind promotion; do not move it yourself.",
  "3. For a stale claim that is transient by nature (a plan, a state, a one-off), call",
  "   memory.archive with a reason. Leave stale claims that are still plainly true alone.",
  "4. Write or rewrite pages with memory.page: one named profile for what is true of the owner",
  "   everywhere, one per project named by its slug. Short markdown grouped under headings, and",
  "   every claim as its own line in exactly the form \"- key: value\" with the claim's real key, so",
  "   the owner can edit a line and have it read back. Current claims only, nothing invented.",
  "   Skip a page whose claims did not change.",
  "",
  "Finish with one short line counting what you merged, archived, flagged and wrote. Only what",
  "you actually called the tools for.",
].join("\n");

/** The dream job exists in every workspace, off until the owner switches it on. */
export function ensureDefaultDreamCron(crons: CronStore): void {
  if (crons.list().some((j) => j.name === DREAM_JOB)) return;
  crons.create({
    name: DREAM_JOB,
    schedule: DREAM_JOB_SCHEDULE,
    type: "self_prompt",
    prompt: DREAM_JOB_PROMPT,
    task: "cheap",
    enabled: false,
  });
}

export const OBSERVE_JOB = "kos.observe";
export const OBSERVE_JOB_SCHEDULE = "15 * * * *";

export const OBSERVE_JOB_PROMPT = [
  "You are keeping long conversations readable by writing notes for yourself, so a thread keeps",
  "its memory without its tokens.",
  "",
  "1. Call memory.threads. It lists conversations whose transcript has grown past the budget,",
  "   with how much is there.",
  "2. For each, call memory.thread with its id to read the older part, the exchanges that would",
  "   be covered. Write a dated note of them, for yourself to pick the work back up: what the",
  "   owner asked for and any constraint or preference they stated; decisions and why; what was",
  "   actually done, with real names and ids; what is unfinished and the next step; anything the",
  "   owner corrected you about. Drop pleasantries, retries and reasoning that led nowhere. Do not",
  "   invent anything, and do not soften a failure into a success.",
  "3. Call memory.observe with the id and the note. The note stands in for the older part; the",
  "   recent exchanges stay as they are.",
  "",
  "Finish with one short line: which threads you observed, or that none needed it.",
].join("\n");

/** The observation job exists in every workspace, off until the owner switches it on. */
export function ensureDefaultObserveCron(crons: CronStore): void {
  if (crons.list().some((j) => j.name === OBSERVE_JOB)) return;
  crons.create({
    name: OBSERVE_JOB,
    schedule: OBSERVE_JOB_SCHEDULE,
    type: "self_prompt",
    prompt: OBSERVE_JOB_PROMPT,
    task: "cheap",
    enabled: false,
  });
}
