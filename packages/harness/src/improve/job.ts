import type { CronStore } from "../cron/store.js";

export const IMPROVE_JOB = "kos.improve";
/** Weekly, Monday at 05:00: improvement is reflective, not urgent. */
export const IMPROVE_JOB_SCHEDULE = "0 5 * * 1";

export const IMPROVE_JOB_PROMPT = [
  "You are looking at your own work to find what could be made reusable, and suggesting it to",
  "the owner. You only suggest. You never create a skill, a module or anything else in this run:",
  "the owner decides, and a suggestion they accept is carried out later, with the usual approvals.",
  "",
  "1. Call improve.list to see what you have already suggested and not had answered; do not raise",
  "   any of those again.",
  "2. Look at what exists and what you have been doing: systems.project_list for the projects,",
  "   modules.list for what is already a module, skills.list for what is already a skill. Read",
  "   recent activity if a tool lets you.",
  "3. Suggest, with improve.suggest, only something that clears a real bar:",
  "   - a blueprint: two or more projects of the same shape (same kind, similar tables) where only",
  "     one, or none, is a module yet. The owner could make the rest instances of one blueprint.",
  "   - a skill: the same multi-step task done by hand more than once that a prompt skill or a",
  "     small script would capture.",
  "   Give a short title, a detail saying what you saw (the evidence, named: which projects, how",
  "   many times), and an action: the plain instruction you would carry out if the owner says yes",
  '   (for example "Promote the pantry project to a module named pantry-tracker").',
  "4. Suggest nothing if nothing clears the bar. A suggestion the owner would dismiss is worse than",
  "   silence. One or two good ones is plenty; never more than three in a run.",
  "",
  'Finish with one short line naming what you suggested, or the words "nothing worth suggesting".',
].join("\n");

/** The improvement job exists in every workspace, off until the owner switches it on. */
export function ensureDefaultImproveCron(crons: CronStore): void {
  if (crons.list().some((j) => j.name === IMPROVE_JOB)) return;
  crons.create({
    name: IMPROVE_JOB,
    schedule: IMPROVE_JOB_SCHEDULE,
    type: "self_prompt",
    prompt: IMPROVE_JOB_PROMPT,
    // Reading and judging is the cheap route's job; the owner can move it.
    task: "cheap",
    enabled: false,
  });
}
