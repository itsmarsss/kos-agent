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
  /**
   * Script skills the owner has let through, by promotion or an approved
   * commit, each with the hash of its files then: run without asking while
   * the files still hash to it, so a schedule can run them.
   */
  promoted: Record<string, string>;
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()))];
}

/** Name to hash. A list of names alone, as older workspaces kept, ties no code: those skills ask again until promoted anew. */
function hashes(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

export function parseSkillSettings(raw: unknown): SkillSettings {
  if (typeof raw !== "object" || raw === null) return { disabled: [], promoted: {} };
  const r = raw as { disabled?: unknown; promoted?: unknown };
  return { disabled: names(r.disabled), promoted: hashes(r.promoted) };
}

export function withSkillEnabled(current: SkillSettings, name: string, enabled: boolean): SkillSettings {
  const disabled = new Set(current.disabled);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  return { ...current, disabled: [...disabled].sort() };
}

/** A skill promoted, as its files hash now: an edit after this makes it ask again. */
export function withSkillPromoted(current: SkillSettings, name: string, hash: string): SkillSettings {
  return { ...current, promoted: { ...current.promoted, [name]: hash } };
}
