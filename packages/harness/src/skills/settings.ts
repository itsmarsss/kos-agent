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
  /** Script skills the owner has let through, by promotion or an approved commit: these run without asking, so a schedule can run them. */
  promoted: string[];
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()))];
}

export function parseSkillSettings(raw: unknown): SkillSettings {
  if (typeof raw !== "object" || raw === null) return { disabled: [], promoted: [] };
  const r = raw as { disabled?: unknown; promoted?: unknown };
  return { disabled: names(r.disabled), promoted: names(r.promoted) };
}

export function withSkillEnabled(current: SkillSettings, name: string, enabled: boolean): SkillSettings {
  const disabled = new Set(current.disabled);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  return { ...current, disabled: [...disabled].sort() };
}

/** A skill promoted: it stays promoted until it is removed, since its code was looked at once. */
export function withSkillPromoted(current: SkillSettings, name: string): SkillSettings {
  return { ...current, promoted: [...new Set([...current.promoted, name])].sort() };
}
