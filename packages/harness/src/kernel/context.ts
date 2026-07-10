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
      mem.push(`- (${f.kind}) ${f.key}: ${f.value}`);
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
    ].join("\n"),
  );

  return sections.join("\n\n");
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
