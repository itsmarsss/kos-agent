import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sweepProfiles } from "./profiles.js";

/** The sweep takes what a stopped Chrome left, and nothing a running one is using or that is not KOS's. */
describe("sweeping left-behind profiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const DAY = 24 * 60 * 60 * 1000;
  const profile = (name: string, options: { lock?: string; ageMs?: number; file?: boolean } = {}): string => {
    const path = join(dir, name);
    mkdirSync(path);
    if (options.file) writeFileSync(join(path, "Preferences"), "{}");
    if (options.lock) symlinkSync(options.lock, join(path, "SingletonLock"));
    if (options.ageMs) {
      const then = new Date(Date.now() - options.ageMs);
      utimesSync(path, then, then);
    }
    return path;
  };
  // A pid this high is past any system's limit, so nothing holds it.
  const DEAD = "host-99999999";

  it("removes a profile whose lock names a process that is gone, however young", async () => {
    const dead = profile("kos-check-dead", { lock: DEAD });
    expect(await sweepProfiles({ dir, processes: async () => [] })).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
  });

  it("keeps a profile whose lock names a running process, however old", async () => {
    const live = profile("kos-check-live", { lock: `host-${process.pid}`, ageMs: 2 * DAY });
    expect(await sweepProfiles({ dir, processes: async () => [] })).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps an unlocked profile younger than a day", async () => {
    const young = profile("kos-check-young", { ageMs: DAY - 60_000 });
    expect(await sweepProfiles({ dir, processes: async () => [] })).toEqual([]);
    expect(existsSync(young)).toBe(true);
  });

  it("removes an unlocked profile older than a day that no running process names", async () => {
    const old = profile("kos-cli-old", { ageMs: 2 * DAY, file: true });
    const named = profile("kos-check-named", { ageMs: 2 * DAY });
    const running = [`/Applications/Chrome --headless=new --user-data-dir=${named} about:blank`];
    expect(await sweepProfiles({ dir, processes: async () => running })).toEqual([old]);
    expect(existsSync(named)).toBe(true);
  });

  it("keeps old unlocked profiles when the running processes cannot be read", async () => {
    const old = profile("kos-check-old", { ageMs: 2 * DAY });
    expect(await sweepProfiles({ dir, processes: async () => undefined })).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it("never touches anything not named kos-*", async () => {
    const other = profile("someone-else", { lock: DEAD, ageMs: 2 * DAY });
    const file = join(dir, "kos-file");
    writeFileSync(file, "x");
    utimesSync(file, new Date(0), new Date(0));
    expect(await sweepProfiles({ dir, processes: async () => [] })).toEqual([]);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("reads the running processes for real", async () => {
    const old = profile("kos-check-real", { ageMs: 2 * DAY });
    expect(await sweepProfiles({ dir })).toEqual([old]);
  });
});
