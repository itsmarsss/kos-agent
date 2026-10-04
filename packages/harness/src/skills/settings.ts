/**
 * Which skills the owner has switched off.
 *
 * Enabled is the default: a skill that exists is offered. Off is a name the
 * owner put on this list from Settings, which keeps the skill on disk and out
 * of the prompt, so turning it back on is a toggle rather than a rewrite.
 */

export const SKILLS_KEY = "skills";

export interface SkillSettings {
  disabled: string[];
}

export function parseSkillSettings(raw: unknown): SkillSettings {
  if (typeof raw !== "object" || raw === null) return { disabled: [] };
  const list = (raw as { disabled?: unknown }).disabled;
  if (!Array.isArray(list)) return { disabled: [] };
  return {
    disabled: [...new Set(list.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()))],
  };
}

export function withSkillEnabled(current: SkillSettings, name: string, enabled: boolean): SkillSettings {
  const disabled = new Set(current.disabled);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  return { disabled: [...disabled].sort() };
}
