import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bwrapCommand } from "./bwrap.js";
import { GIT_CONTROL_WRITES } from "./githold.js";
import { gitControls, plantedControls, quarantine, stuckUnder } from "./gitwatch.js";

describe("git control watched across a run nobody approved", () => {
  let ws: string;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "kos-gitwatch-")));
  });

  afterEach(() => {
    for (const dir of [ws, join(ws, "n")]) if (existsSync(dir)) chmodSync(dir, 0o755);
    rmSync(ws, { recursive: true, force: true });
  });

  const plant = (repo: string): void => {
    mkdirSync(join(ws, repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(ws, repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch PLANTED\n");
  };

  it("takes away a repository planted in a folder locked with chmod 555", () => {
    const before = gitControls([ws], 1000);
    plant("n");
    chmodSync(join(ws, "n"), 0o555);
    const taken = quarantine(ws, plantedControls(before, gitControls([ws], 1000)));
    expect(taken).toEqual({ moved: ["n/.git"], failed: [] });
    expect(existsSync(join(ws, "n", ".git"))).toBe(false);
    const [stamp] = readdirSync(join(ws, ".kos", "quarantine"));
    expect(existsSync(join(ws, ".kos", "quarantine", stamp!, "n", ".git", "hooks", "pre-commit"))).toBe(true);
  });

  it.runIf(process.getuid?.() !== 0)("reports what it cannot take away, and refuses unapproved runs in that tree while it stands", () => {
    // A file this user can neither move nor remove: root's own.
    const taken = quarantine(ws, ["/etc/hosts"]);
    expect(taken.failed).toEqual(["hosts"]);
    expect(stuckUnder(["/etc"])).toBe("/etc/hosts");
    expect(stuckUnder([ws])).toBeUndefined();
  });

  it("walks the tree after the run without a cap, so a run that grew it past the cap is still quarantined", () => {
    mkdirSync(join(ws, "proj"));
    const command = bwrapCommand("/usr/bin/bwrap", "/bin/sh", ["-c", "true"], { workspaceRoot: ws, secretFiles: [], unwritable: GIT_CONTROL_WRITES, network: false, walkLimit: 50 });
    for (let i = 0; i < 200; i++) writeFileSync(join(ws, "proj", `f${i}`), "");
    plant("proj/n");
    expect(command.release?.()).toEqual({ quarantined: ["proj/n/.git"], quarantineFailed: [] });
  });
});
