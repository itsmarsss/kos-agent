import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Workspace } from "../store/workspace.js";

/**
 * User profile: identity read at boot. The seed/config file is the source of
 * truth (the dashboard and CLI only edit it, so there are no parallel paths
 * that disagree). Timezone underpins all scheduling and date math. ownerId is
 * the present-but-fixed single-owner id the rest of the system threads through.
 */
export interface Profile {
  ownerId: string;
  name: string;
  timezone: string;
  channels: Record<string, string>;
  preferences: Record<string, unknown>;
}

export const PROFILE_FILE = "profile.json";

export const DEFAULT_PROFILE: Profile = {
  ownerId: "owner",
  name: "Owner",
  timezone: "UTC",
  channels: {},
  preferences: {},
};

/** Load the profile from the workspace, or undefined if first run. */
export function loadProfile(ws: Workspace): Profile | undefined {
  const path = ws.resolve(PROFILE_FILE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Profile;
}

/** Write the profile file (the only writer to the source of truth). */
export function saveProfile(ws: Workspace, profile: Profile): void {
  writeFileSync(ws.resolve(PROFILE_FILE), JSON.stringify(profile, null, 2));
}

/**
 * Read the profile at boot; on first run (no file) seed one from defaults plus
 * any overrides and persist it. Returns the effective profile.
 */
export function ensureProfile(
  ws: Workspace,
  overrides: Partial<Profile> = {},
): Profile {
  const existing = loadProfile(ws);
  if (existing) return existing;
  const profile: Profile = { ...DEFAULT_PROFILE, ...overrides };
  saveProfile(ws, profile);
  return profile;
}
