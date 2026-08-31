import type { Project } from "../systems/manifest.js";
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
  recall: Recall;
  extra?: string;
}

/** Build the system prompt block for one agent turn. */
export function assembleSystemPrompt(parts: ContextParts): string {
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

  const { facts, episodes } = parts.recall;
  if (facts.length > 0 || episodes.length > 0) {
    const mem: string[] = ["## Salient memory"];
    for (const f of facts.slice(0, 12)) {
      const marks = [f.kind, ...(f.pinned ? ["pinned"] : []), ...f.tags];
      mem.push(`- (${marks.join(", ")}) ${f.key}: ${f.value}`);
    }
    for (const e of episodes.slice(0, 5)) {
      mem.push(`- episode: ${e.text.slice(0, 200)}`);
    }
    sections.push(mem.join("\n"));
  }

  if (parts.extra?.trim()) {
    sections.push(parts.extra.trim());
  }

  sections.push(
    [
      "## Tool guidance",
      "Compose primitive tools. Use systems.project_create + systems.migrate for schemas (never raw DDL via sql).",
      "Use pages.write to register dashboard pages. Risky actions are queued for approval.",
      "Prefer sql SELECT for inspection; writes may require approval.",
      "Use export.query to hand over a csv/markdown/json file instead of pasting a large table into chat.",
      "For a reusable script: write it with files.write under skills/, then skills.test, then skills.promote. Never run one live without testing it first.",
    ].join("\n"),
  );

  return sections.join("\n\n");
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
  ].join("\n");
}

/**
 * Infer scope tags from user text so tagged tools surface when relevant.
 * Untagged tools are always offered by the registry.
 */
export function inferScopeTags(text: string): string[] {
  const t = text.toLowerCase();
  const tags = new Set<string>();
  if (/\b(cron|schedule|remind|every day|hourly)\b/.test(t)) tags.add("cron");
  if (/\b(http|fetch|url|https?:\/\/|api\.|webhook)\b/.test(t)) tags.add("http");
  if (
    /\b(migrate|schema|project|page|widget|dashboard|budget|table)\b/.test(t)
  ) {
    tags.add("systems");
  }
  if (/\b(task|todo|checklist|habit)\b/.test(t)) tags.add("tasks");
  if (/\b(search|find|grep|look up|semantic)\b/.test(t)) tags.add("search");
  if (/\b(export|csv|spreadsheet|download|report)\b/.test(t)) tags.add("export");
  if (/\b(skill|script|automate|reusable|routine)\b/.test(t)) tags.add("skills");
  if (/\b(file|read|write|edit|folder|directory|scratch)\b/.test(t)) {
    tags.add("files");
  }
  // Always allow systems when talking about building things.
  if (/\b(build|track|create a|make me|set up)\b/.test(t)) {
    tags.add("systems");
    tags.add("tasks");
  }
  return [...tags];
}
