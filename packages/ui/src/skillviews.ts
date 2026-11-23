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

/** How long a skill's line in the list may run before it is cut at a word. */
const SUMMARY_MAX = 160;

/**
 * A skill's own summary, for the list: its description up to the first
 * TRIGGER or SKIP block (the rules a model reads to decide when to use it,
 * not words for the owner), then its first sentence, cut at a word.
 */
export function skillSummary(description: string): string {
  const cut = /\b(?:TRIGGER|SKIP)\b/.exec(description);
  const plain = (cut ? description.slice(0, cut.index) : description).replace(/\s+/g, " ").trim();
  const sentence = (/^.*?[.!?](?=\s+[A-Z]|$)/.exec(plain)?.[0] ?? plain).replace(/[\s:;,\u2014-]+$/, "");
  if (sentence.length <= SUMMARY_MAX) return sentence;
  const head = sentence.slice(0, SUMMARY_MAX);
  return `${head.slice(0, head.lastIndexOf(" ")).replace(/[\s:;,\u2014-]+$/, "")}…`;
}
