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
