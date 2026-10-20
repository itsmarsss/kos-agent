import type { SkillInfo } from "./api.js";

/**
 * Which skills to show: all of them, the ones for everywhere, one project's
 * own, or by kind and state. A flat list of every skill KOS has written or
 * the owner installed stopped answering "what does this project have" once
 * it passed a screen.
 */

export interface SkillView {
  value: string;
  label: string;
  hint?: string;
}

const FIXED: SkillView[] = [
  { value: "all", label: "All skills" },
  { value: "everywhere", label: "For everywhere", hint: "no project named" },
  { value: "script", label: "Scripts" },
  { value: "prompt", label: "Prompt skills" },
  { value: "promoted", label: "Promoted", hint: "scripts that run without asking" },
  { value: "off", label: "Switched off" },
];

/** The views the list offers: the fixed ones, then one per project any skill names. */
export function skillViews(skills: readonly SkillInfo[]): SkillView[] {
  const projects = [...new Set(skills.flatMap((s) => s.projects ?? []))].sort();
  return [...FIXED, ...projects.map((slug) => ({ value: `project:${slug}`, label: slug, hint: "its own skills" }))];
}

export function matchesSkillView(skill: SkillInfo, view: string): boolean {
  switch (view) {
    case "all":
      return true;
    case "everywhere":
      return !skill.projects?.length;
    case "script":
    case "prompt":
      return skill.kind === view;
    case "promoted":
      return skill.promoted === true;
    case "off":
      return !skill.enabled;
    default:
      return view.startsWith("project:") ? (skill.projects ?? []).includes(view.slice("project:".length)) : true;
  }
}
