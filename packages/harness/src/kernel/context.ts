import type { ModelMessage } from "../models/types.js";
import type { Project } from "../systems/manifest.js";
import { renderSchemas, type ProjectSchema } from "../systems/schema.js";
import { renderSkillsSection, type SkillRecord } from "../skills/manifest.js";
import type { Recall } from "../memory/retriever.js";
import type { Profile } from "./profile.js";

/**
 * Context assembly: each prompt gets profile + manifest summary + salient
 * memory, never a dump of everything. Pure functions so the policy is tested
 * without booting the kernel.
 */

export interface ContextParts {
  baseSystem: string;
  profile: Profile;
  projects: Project[];
  /** The tables the active projects own, so sql is written against real names. */
  schemas?: ProjectSchema[];
  /** Skills the owner has not switched off, by name and description, so the model can reach for one. */
  skills?: SkillRecord[];
  recall: Recall;
  /** Per-conversation, so it belongs with the fixed half. */
  extra?: string;
  /** Derived from this message, so it rides with the turn. */
  turnExtra?: string;
}

/**
 * What is fixed, and what this particular turn dragged in.
 *
 * Both providers cache by matching the front of a prompt against the last one
 * and charging a fraction for the part that matches. So anything that differs
 * per turn must come after everything that does not, or it ends the match
 * where it sits.
 *
 * The system prompt is the very front of the prompt, so anything volatile in
 * it ends the match before the tools -- which are large, fixed, and where
 * most of the saving is. Measured on a real workspace: with salient memory in
 * the system prompt the stable prefix was about 525 tokens, under OpenAI's
 * 1,024 minimum, so nothing cached at all out of 8,344.
 *
 * Split, the system prompt is identical every turn and the turn's own context
 * rides on the user's message, after the tools and after the history. What
 * differs is then at the very end, where it costs nothing.
 */
export interface AssembledPrompt {
  /** Identical between turns, so it caches. */
  system: string;
  /** Retrieved for this message. Empty when there was nothing. */
  turnContext: string;
}

/**
 * Marks the block so it can be taken out again before the turn is stored.
 *
 * Recalled memory is derived from the transcript; storing it back into the
 * transcript would grow it every turn and feed itself.
 */
export const TURN_CONTEXT_HEADER = "## Recalled for this turn";

/** Build the system prompt block for one agent turn. */
export function assembleSystemPrompt(parts: ContextParts): AssembledPrompt {
  const sections: string[] = [parts.baseSystem.trim()];

  sections.push(
    [
      "## Profile",
      `name: ${parts.profile.name}`,
      `timezone: ${parts.profile.timezone}`,
      `ownerId: ${parts.profile.ownerId}`,
    ].join("\n"),
  );

  const active = parts.projects.filter((p) => p.status === "active");
  const others = parts.projects.filter((p) => p.status !== "active");
  const projectLines: string[] = ["## Projects (manifest)"];
  if (parts.projects.length === 0) {
    projectLines.push("(none yet)");
  } else {
    for (const p of active.slice(0, 20)) {
      projectLines.push(
        `- ${p.slug} [${p.type}/${p.status}]${p.module ? ` module=${p.module}` : ""}${p.description ? `: ${p.description}` : ""}`,
      );
    }
    if (others.length > 0) {
      projectLines.push(
        `…and ${others.length} non-active project(s) (dormant/done/archived)`,
      );
    }
  }
  sections.push(projectLines.join("\n"));
  const tables = renderSchemas(parts.schemas ?? []);
  if (tables) sections.push(tables);
  const skills = renderSkillsSection(parts.skills ?? []);
  if (skills) sections.push(skills);

  /*
   * What changes every turn goes last, not in the middle.
   *
   * Both providers cache by matching the front of a prompt against the last
   * one and charging a fraction for the part that matches. Salient memory is
   * retrieved per message, so sitting where it did it differed on every turn
   * and ended the match right there -- leaving the largest stable block, the
   * tool guidance below it, permanently uncacheable. Measured against the
   * live API: 0 cached tokens on a second turn that reused 8k of prompt.
   *
   * Held here and appended after everything fixed.
   */
  const volatile: string[] = [];
  if (parts.turnExtra?.trim()) volatile.push(parts.turnExtra.trim());
  const { facts, events } = parts.recall;
  if (facts.length > 0 || events.length > 0) {
    const mem: string[] = ["## Salient memory"];
    for (const f of facts.slice(0, 12)) {
      const marks = [f.kind, ...(f.pinned ? ["pinned"] : []), ...f.tags];
      mem.push(`- (${marks.join(", ")}) ${f.key}: ${f.value}`);
    }
    for (const e of events.slice(0, 5)) {
      const when = new Date(e.ts).toISOString().slice(0, 10);
      const where = e.projectSlug ? `, ${e.projectSlug}` : "";
      mem.push(`- earlier (${when}${where}, ${e.role}): ${e.text.slice(0, 200)}`);
    }
    volatile.push(mem.join("\n"));
  }

  if (parts.extra?.trim()) {
    sections.push(parts.extra.trim());
  }

  sections.push(
    [
      "## Tool guidance",
      "Compose primitive tools. Use systems.project_create + systems.migrate for schemas (never raw DDL via sql).",
      "Use pages.write to register dashboard pages. Risky actions are queued for approval.",
      "Refer to something of the owner\u2019s by writing @project:<slug>, @page:<id>, @file:<workspace/relative/path> or @schedule:<job name>. These render as links they can click, so use them instead of quoting a bare name: say the page is @page:budget-dashboard rather than \"the budget dashboard page\". Put the id in square brackets when it contains a space, as a job name usually does: @schedule:[9 AM Pinger Test]. Without them it is read as far as the first space and points at nothing. Only write one you know exists; a wrong id renders as a dead link.",
      "A project is what a page or a table belongs to. Pick it by the data: a page goes in the project whose tables its queries read. A page that queries nothing reads no project's data, so it gets its own project via systems.project_create, never the nearest slug from the list above. The list is what exists, not a menu to file new work under.",
      "Prefer sql SELECT for inspection; writes may require approval.",
      "Use export.query to hand over a csv/markdown/json file instead of pasting a large table into chat.",
      "For something you will do again, make a skill with skills.create: instructions as a prompt skill, code as a script skill. A script is tested with skills.test and promoted with skills.promote before skills.run may run it.",
    ].join("\n"),
  );

  return {
    system: sections.join("\n\n"),
    turnContext: volatile.length
      ? [TURN_CONTEXT_HEADER, ...volatile].join("\n\n")
      : "",
  };
}

/**
 * How to present a reply on a given channel. The agent loop is channel
 * agnostic, so the surface's capabilities have to be described to the model
 * rather than assumed: it decides the shape of its own answer, and can only do
 * that well if it knows what the destination renders.
 */
export function channelGuidance(channel?: string): string | undefined {
  if (channel !== "discord") return undefined;
  return [
    "## Replying on Discord",
    "Your reply is sent as an ordinary Discord message, so you choose the presentation.",
    "Available: # ## ### headings, -# subtext, **bold**, *italic*, __underline__,",
    "~~strikethrough~~, ||spoiler||, `inline code`, ```lang fenced code blocks```,",
    "- bullet and 1. numbered lists (indent to nest), > quote and >>> block quote.",
    "Discord has no table syntax. For anything column-shaped use a fenced code block",
    "and pad the columns, or use a list. Prefer raw URLs; masked links are unreliable here.",
    "Match the format to the answer: a one-line question gets one line, not a heading.",
    "Reach for structure when it earns its place, such as steps, comparisons, or query output.",
    "Messages over 2000 characters are split, so keep replies tight and put bulk in a file via export.query.",
    "",
    "### Answering with a card or buttons",
    "You are a bot here, so you can send more than prose. notify sends a message: give it a",
    "`card` for a titled block with labelled fields, or `buttons` for something to press",
    "instead of asking the reader to type back. It is its own message, so keep your reply",
    "short or skip it when the message says everything.",
    "A card suits a handful of named values, a status, or one thing with a few facts about it.",
    "Prose suits everything else: a card around a paragraph is a box around a paragraph.",
    "A button needs a label that says what pressing it does, because the press comes back to",
    "you as a message naming that label. Offer them when the next step is one of a few known",
    "choices, not as decoration on an answer that needed none. Your answer to a press goes",
    "back to whoever pressed it, so write it as a reply to them.",
    "For an answer that is not one of a fixed few -- a note, an amount, a name -- give the",
    "button a `modal`: a form of up to five boxes, whose contents arrive with the press.",
    "Set `ephemeral` on a button when its answer is for the presser alone.",
    "When you are answering a press, the message you send with notify is the answer, whole.",
    "Do not also write a reply about having sent it: it goes nowhere, and the reader wanted",
    "the thing, not a note saying the thing was sent.",
  ].join("\n");
}


/**
 * Take the turn's recalled context back out before the turn is stored.
 *
 * It was sent so the model had it, at the end of the prompt where it does not
 * spoil the cache. It must not be kept: recall is derived from the transcript,
 * so storing it appends a copy of the transcript's own summary to the
 * transcript, every turn, for the model to summarise again next time.
 */
export function withoutTurnContext(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }
    const kept = message.content.filter(
      (block) =>
        !(block.type === "text" && block.text.startsWith(TURN_CONTEXT_HEADER)),
    );
    return kept.length === message.content.length
      ? message
      : { ...message, content: kept };
  });
}
