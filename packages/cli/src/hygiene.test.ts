import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialModes, kosHome, leftoverTranscripts, syncedFolder, tightenKosHome } from "./hygiene.js";

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("credential hygiene on disk", () => {
  let home: string;
  let kos: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kos-hygiene-")));
    kos = kosHome(home);
    mkdirSync(join(kos, "locks"), { recursive: true, mode: 0o755 });
    mkdirSync(join(kos, "secrets"), { mode: 0o700 });
    chmodSync(kos, 0o755);
    chmodSync(join(kos, "locks"), 0o755);
    writeFileSync(join(kos, "device-host.key"), "k", { mode: 0o644 });
    writeFileSync(join(kos, "locks", "imessage-x.lock"), "1", { mode: 0o644 });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("makes ~/.kos, its locks and their files the owner's alone, and says what it changed", () => {
    const outside = join(home, "elsewhere");
    writeFileSync(outside, "x", { mode: 0o644 });
    symlinkSync(outside, join(kos, "link"));
    expect(tightenKosHome(kos).sort()).toEqual([kos, join(kos, "device-host.key"), join(kos, "locks"), join(kos, "locks", "imessage-x.lock")].sort());
    expect(modeOf(kos)).toBe(0o700);
    expect(modeOf(join(kos, "locks"))).toBe(0o700);
    expect(modeOf(join(kos, "device-host.key"))).toBe(0o600);
    expect(modeOf(join(kos, "locks", "imessage-x.lock"))).toBe(0o600);
    // A link is not followed out of ~/.kos.
    expect(modeOf(outside)).toBe(0o644);
    expect(tightenKosHome(kos)).toEqual([]);
  });

  it("does nothing where there is no ~/.kos yet", () => {
    expect(tightenKosHome(join(home, "none"))).toEqual([]);
  });

  it("names every credential file and folder others can reach, Google's token files among them", () => {
    const env = join(home, "repo", ".env");
    const credentials = join(home, "repo", "secrets");
    mkdirSync(credentials, { recursive: true, mode: 0o755 });
    chmodSync(credentials, 0o755);
    writeFileSync(env, "A=b\n", { mode: 0o644 });
    writeFileSync(join(credentials, "google-calendar-tokens.json"), "{}", { mode: 0o644 });
    const apns = join(home, "apns.p8");
    writeFileSync(apns, "p8", { mode: 0o640 });
    const found = credentialModes({ env: { KOS_APNS_KEY_FILE: apns }, envFile: env, credentials, home });
    expect(found.map((f) => f.path).sort()).toEqual([kos, join(kos, "device-host.key"), join(kos, "locks"), join(kos, "locks", "imessage-x.lock"), env, credentials, join(credentials, "google-calendar-tokens.json"), apns].sort());
    expect(found.find((f) => f.path === env)?.detail).toBe(`mode 644, open to others: chmod 600 ${env}`);
    tightenKosHome(kos);
    for (const path of [env, apns, join(credentials, "google-calendar-tokens.json")]) chmodSync(path, 0o600);
    chmodSync(credentials, 0o700);
    expect(credentialModes({ env: { KOS_APNS_KEY_FILE: apns }, envFile: env, credentials, home })).toEqual([]);
  });

  it("says when the env file is in a folder a sync client may copy, by its path alone", () => {
    expect(syncedFolder(join(home, "Documents", "kos-agent", ".env"), home)).toMatch(/^Documents, which iCloud syncs/);
    expect(syncedFolder(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", ".env"), home)).toBe("iCloud Drive");
    expect(syncedFolder(join(home, "Library", "CloudStorage", "Dropbox", ".env"), home)).toBe("a cloud storage client");
    expect(syncedFolder(join(home, "Dropbox", "kos", ".env"), home)).toBe("Dropbox");
    expect(syncedFolder(join(home, ".kos", "env"), home)).toBeUndefined();
    expect(syncedFolder(join(home, "DocumentsOld", ".env"), home)).toBeUndefined();
    expect(syncedFolder("/etc/kos/env", home)).toBeUndefined();
  });

  it("lists the transcripts Claude Code kept of KOS's work, and none of the owner's own", () => {
    const workspace = join(home, "kos-workspace");
    const key = workspace.replace(/[^a-zA-Z0-9]/g, "-");
    const projects = join(home, ".claude", "projects");
    for (const dir of [key, `${key}-sites-app`, "-Users-me-code-mine"]) {
      mkdirSync(join(projects, dir), { recursive: true });
      writeFileSync(join(projects, dir, "s.jsonl"), "{}\n");
    }
    mkdirSync(join(kos, "claude", "projects", "-x"), { recursive: true });
    writeFileSync(join(kos, "claude", "projects", "-x", "t.jsonl"), "{}\n");
    expect(leftoverTranscripts(workspace, home).sort()).toEqual(
      [join(projects, key, "s.jsonl"), join(projects, `${key}-sites-app`, "s.jsonl"), join(kos, "claude", "projects", "-x", "t.jsonl")].sort(),
    );
  });
});
