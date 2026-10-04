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
  "You are maintaining your own long-term memory about the owner.",
  "",
  "1. Call memory.unread. It gives you new conversation events with ids, and the claims already",
  "   remembered that might relate.",
  "2. For each thing worth keeping months from now (identities, relationships, preferences,",
  "   decisions, constraints, recurring arrangements, tools and services, facts about a project),",
  "   call memory.remember with evidence: the ids of the events it came from. When a related claim",
  "   already covers it, use that claim's exact key so the new value replaces the old one. Use",
  '   scope "project" for things about the project the events belong to, "global" for the owner.',
  "3. Drop questions, one-off requests, small talk, transient state, and anything you guessed",
  "   rather than the owner said. Never store secrets, passwords, card numbers or API keys.",
  "4. Call memory.mark_read with the cursor you were given. If remaining was above zero, go",
  "   back to step 1, up to five times.",
  "",
  "Finish with one short line: what you kept, or that there was nothing to keep. No report.",
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
