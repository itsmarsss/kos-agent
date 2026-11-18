import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { namesProfile, sweepProfiles, type ProcessInfo } from "./profiles.js";

/** Room for a process to start or go on a machine busy running the whole suite. */
const WAIT = { timeout: 10_000 };

/** The sweep takes what a stopped Chrome left, and nothing a running one is using or that is not a Chrome profile of KOS's. */
describe("sweeping left-behind profiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const DAY = 24 * 60 * 60 * 1000;
  /** A folder, as Chrome would leave it unless told it holds nothing of Chrome's. */
  const profile = (name: string, options: { lock?: string; ageMs?: number; chrome?: boolean } = {}): string => {
    const path = join(dir, name);
    mkdirSync(path);
    if (options.chrome !== false) {
      writeFileSync(join(path, "Local State"), "{}");
      mkdirSync(join(path, "Default"));
      writeFileSync(join(path, "Default", "Preferences"), "x".repeat(1000));
    }
    if (options.lock) symlinkSync(options.lock, join(path, "SingletonLock"));
    if (options.ageMs) {
      const then = new Date(Date.now() - options.ageMs);
      utimesSync(path, then, then);
    }
    return path;
  };
  // A pid this high is past any system's limit, so nothing holds it.
  const DEAD = "host-99999999";
  const none = async (): Promise<ProcessInfo[]> => [];

  it("removes a profile whose lock names a process that is gone, however young, and says what it freed", async () => {
    const dead = profile("kos-check-dead", { lock: DEAD });
    const result = await sweepProfiles({ dir, processes: none });
    expect(result).toMatchObject({ removed: [dead], failed: [], stopped: [] });
    expect(result.freed).toBeGreaterThanOrEqual(1002);
    expect(existsSync(dead)).toBe(false);
  });

  it("keeps a profile whose Chrome is running with its parent alive, however old", async () => {
    const live = profile("kos-check-live", { lock: `host-${process.pid}`, ageMs: 2 * DAY });
    const self: ProcessInfo = { pid: process.pid, ppid: process.ppid, pgid: process.pid, args: `chrome --user-data-dir=${live}` };
    expect((await sweepProfiles({ dir, processes: async () => [self] })).removed).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps an unlocked profile younger than a day", async () => {
    const young = profile("kos-check-young", { ageMs: DAY - 60_000 });
    expect((await sweepProfiles({ dir, processes: none })).removed).toEqual([]);
    expect(existsSync(young)).toBe(true);
  });

  it("removes an unlocked Chrome profile older than a day that no running process names", async () => {
    const old = profile("kos-cli-old", { ageMs: 2 * DAY });
    const named = profile("kos-check-named", { ageMs: 2 * DAY });
    const running: ProcessInfo[] = [{ pid: 5, ppid: 1, pgid: 5, args: `/Applications/Chrome --headless=new --user-data-dir ${named} about:blank` }];
    expect((await sweepProfiles({ dir, processes: async () => running })).removed).toEqual([old]);
    expect(existsSync(named)).toBe(true);
  });

  it("leaves an old kos-* folder alone that holds nothing of Chrome's", async () => {
    const notChrome = profile("kos-cli-leak", { chrome: false });
    writeFileSync(join(notChrome, "kos.sqlite"), "x");
    utimesSync(notChrome, new Date(0), new Date(0));
    expect((await sweepProfiles({ dir, processes: none })).removed).toEqual([]);
    expect(existsSync(notChrome)).toBe(true);
  });

  it("keeps old unlocked profiles when the running processes cannot be read", async () => {
    const old = profile("kos-check-old", { ageMs: 2 * DAY });
    expect((await sweepProfiles({ dir, processes: async () => undefined })).removed).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it("never touches anything not named kos-*, nor a kos-* symlink", async () => {
    const other = profile("someone-else", { lock: DEAD, ageMs: 2 * DAY });
    const file = join(dir, "kos-file");
    writeFileSync(file, "x");
    utimesSync(file, new Date(0), new Date(0));
    const target = profile("elsewhere", { lock: DEAD });
    symlinkSync(target, join(dir, "kos-check-link"));
    expect((await sweepProfiles({ dir, processes: none })).removed).toEqual([]);
    expect([other, file, target, join(dir, "kos-check-link")].every((p) => existsSync(p))).toBe(true);
  });

  it("reads the running processes for real", async () => {
    const old = profile("kos-check-real", { ageMs: 2 * DAY });
    expect((await sweepProfiles({ dir })).removed).toEqual([old]);
  });

  it("runs one sweep at a time: a call while one runs gets that one", async () => {
    profile("kos-check-dead", { lock: DEAD });
    const first = sweepProfiles({ dir, processes: none });
    expect(sweepProfiles({ dir, processes: none })).toBe(first);
    // Another folder gets a sweep of its own.
    const other = mkdtempSync(join(tmpdir(), "sweep-other-"));
    try {
      expect(sweepProfiles({ dir: other, processes: none })).not.toBe(first);
    } finally {
      await sweepProfiles({ dir: other, processes: none });
      rmSync(other, { recursive: true, force: true });
    }
    await first;
    expect(sweepProfiles({ dir, processes: none })).not.toBe(first);
  });

  it("deletes a backlog a couple at a time, every one of it", async () => {
    const all = Array.from({ length: 6 }, (_, i) => profile(`kos-check-dead-${i}`, { lock: DEAD }));
    const result = await sweepProfiles({ dir, processes: none });
    expect(result.removed.sort()).toEqual(all.sort());
    expect(all.some((p) => existsSync(p))).toBe(false);
  });
});

describe("a command line naming a profile", () => {
  it("matches either flag form and any spelling of the folder, and nothing else", () => {
    const path = "/var/folders/ab/T/kos-check-abc";
    expect(namesProfile(`chrome --user-data-dir=${path} about:blank`, path)).toBe(true);
    expect(namesProfile(`chrome --user-data-dir ${path}`, path)).toBe(true);
    expect(namesProfile("chrome --user-data-dir=/var/folders/ab/T//kos-check-abc/ x", path)).toBe(true);
    expect(namesProfile(`chrome --user-data-dir=/private${path}`, path)).toBe(true);
    expect(namesProfile(`chrome --user-data-dir=${path}`, `/private${path}`)).toBe(true);
    expect(namesProfile(`chrome --user-data-dir=${path}d`, path)).toBe(false);
    expect(namesProfile("chrome --user-data-dir=/var/folders/ab/T/kos-check-other", path)).toBe(false);
    expect(namesProfile(`chrome ${path}`, path)).toBe(false);
  });
});

/**
 * Chrome left running by a host that crashed: a stand-in that, like Chrome,
 * leads its own process group with a helper in it, and here ignores SIGTERM
 * so the kill is what stops it.
 */
describe("orphaned Chromes", () => {
  let dir: string;
  /** What each test started, to be killed after it: a negative number is a group. */
  const started: number[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-orphan-"));
  });
  afterEach(() => {
    for (const target of started.splice(0)) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** The stand-in's code: deaf to SIGTERM, a deaf helper in its group, and both pids written once listening. */
  const standIn = (pids: string): string =>
    `process.on("SIGTERM", () => {}); const h = require("child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); h.on("spawn", () => require("fs").writeFileSync(${JSON.stringify(pids)}, process.pid + " " + h.pid)); setInterval(() => {}, 1000);`;

  /**
   * Start a stand-in on a profile and lock the profile to it. Orphaned: started
   * by a go-between that exits, so its parent becomes launchd. It leads its own
   * group, as KOS starts Chrome, unless told not to: then it is in the
   * go-between's group, beside a bystander that names no profile. Else its
   * parent is this test. Its pid, its helper's, and the bystander's if any.
   */
  async function chrome(profilePath: string, options: { orphan: boolean; names?: string; leads?: boolean }): Promise<[number, number, number?]> {
    mkdirSync(profilePath);
    writeFileSync(join(profilePath, "Local State"), "{}");
    const pids = join(dir, `${started.length}.pids`);
    const bystander = `${pids}.bystander`;
    const args = ["-e", standIn(pids), "--", `--user-data-dir=${options.names ?? profilePath}`];
    if (!options.orphan) {
      spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
    } else if (options.leads === false) {
      const between = `const { spawn } = require("child_process"); spawn(process.execPath, ${JSON.stringify(args)}, { stdio: "ignore" }).unref(); const b = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); b.unref(); require("fs").writeFileSync(${JSON.stringify(bystander)}, String(b.pid));`;
      await new Promise((resolve) => spawn(process.execPath, ["-e", between], { detached: true, stdio: "ignore" }).once("exit", resolve));
    } else {
      const between = `require("child_process").spawn(process.execPath, ${JSON.stringify(args)}, { detached: true, stdio: "ignore" }).unref();`;
      await new Promise((resolve) => spawn(process.execPath, ["-e", between], { stdio: "ignore" }).once("exit", resolve));
    }
    await vi.waitFor(() => expect(existsSync(pids) && readFileSync(pids, "utf8")).toBeTruthy(), WAIT);
    const [pid, helper] = readFileSync(pids, "utf8").split(" ").map(Number) as [number, number];
    symlinkSync(`host-${pid}`, join(profilePath, "SingletonLock"));
    if (options.leads === false) {
      const other = Number(readFileSync(bystander, "utf8"));
      started.push(pid, helper, other);
      return [pid, helper, other];
    }
    started.push(-pid);
    return [pid, helper];
  }

  it("stops an orphaned KOS Chrome on exactly that profile, its group with it, then deletes the profile", async () => {
    const path = join(dir, "kos-check-orphan");
    const [pid, helper] = await chrome(path, { orphan: true });
    const result = await sweepProfiles({ dir });
    expect(result.stopped).toEqual([pid]);
    expect(result.removed).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    await vi.waitFor(() => expect(running(pid) || running(helper)).toBe(false), WAIT);
  }, 20_000);

  it("never touches a Chrome whose parent is alive, or one started on another folder", async () => {
    const parented = join(dir, "kos-check-parented");
    const [mine] = await chrome(parented, { orphan: false });
    const elsewhere = join(dir, "kos-check-elsewhere");
    const [other] = await chrome(elsewhere, { orphan: true, names: join(dir, "kos-check-another") });
    const result = await sweepProfiles({ dir });
    expect(result).toMatchObject({ removed: [], stopped: [] });
    expect([parented, elsewhere].every((p) => existsSync(p))).toBe(true);
    expect(running(mine) && running(other)).toBe(true);
  }, 20_000);

  it("signals an orphan that leads no group alone, and leaves the group it is in", async () => {
    const path = join(dir, "kos-check-member");
    const [pid, , bystander] = await chrome(path, { orphan: true, leads: false });
    const result = await sweepProfiles({ dir });
    expect(result.stopped).toEqual([pid]);
    expect(existsSync(path)).toBe(false);
    expect(running(pid)).toBe(false);
    expect(running(bystander!)).toBe(true);
  }, 20_000);

  it("looks again before each signal, and stops nothing that is no longer that orphan", async () => {
    const path = join(dir, "kos-check-adopted");
    const [pid] = await chrome(path, { orphan: false });
    // Orphaned when the folder was read, someone's child by the time it would be stopped.
    let reads = 0;
    const processes = async (): Promise<ProcessInfo[]> => [{ pid, ppid: reads++ === 0 ? 1 : process.pid, pgid: pid, args: `chrome --user-data-dir=${path}` }];
    const result = await sweepProfiles({ dir, processes });
    expect(result).toMatchObject({ removed: [], stopped: [] });
    expect(reads).toBe(2);
    expect(running(pid)).toBe(true);
  }, 20_000);
});
