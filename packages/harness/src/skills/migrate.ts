import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Workspace } from "../store/workspace.js";
import { MANIFEST_FILE, readSkills, skillHashNow, type SkillRecord } from "./manifest.js";

/**
 * The hash a promotion kept before it covered the whole folder: the entry
 * and skill.json alone. Read only to carry an old yes over, never to judge.
 */
export function legacySkillHash(ws: Workspace, skill: SkillRecord): string {
  const hash = createHash("sha256");
  for (const file of [skill.file, join(skill.dir, MANIFEST_FILE)]) {
    const abs = ws.resolve(file);
    hash.update(file).update("\0").update(existsSync(abs) ? readFileSync(abs) : "").update("\0");
  }
  return hash.digest("hex");
}

export interface PromotedMigration {
  /** The promotions as they stand after: carried over to the folder hash, the rest kept as they were. */
  promoted: Record<string, string>;
  /** Carried over: the files the owner approved are the files there now. */
  carried: string[];
  /** Kept under the old hash, which their files no longer give: promoted anew before they run unasked. */
  stale: string[];
}

/**
 * Promotions kept under the two-file hash, carried over to the folder-wide
 * one where the owner's yes still holds: the entry and skill.json hash now
 * to what was approved, so the folder as it is now is taken as what was
 * approved. One that already holds the folder hash is left alone; one that
 * matches neither (changed since, or holding a link) is named as stale.
 */
export function migratePromoted(ws: Workspace, promoted: Record<string, string>): PromotedMigration {
  const { skills } = readSkills(ws);
  const out: Record<string, string> = { ...promoted };
  const carried: string[] = [];
  const stale: string[] = [];
  for (const [name, hash] of Object.entries(promoted)) {
    const skill = skills.find((s) => s.manifest.name === name && s.manifest.kind === "script");
    const now = skill ? skillHashNow(ws, skill) : undefined;
    if (now !== undefined && now === hash) continue;
    if (skill && now !== undefined && legacySkillHash(ws, skill) === hash) {
      out[name] = now;
      carried.push(name);
    } else {
      stale.push(name);
    }
  }
  return { promoted: out, carried, stale };
}
