import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { childEnv, deviceUpdates, macInstaller } from "./deviceupdates.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A program for the installer to run in place of bundle.sh. */
function script(body: string): string {
  dir ||= mkdtempSync(join(tmpdir(), "deviceupdates-test-"));
  const path = join(dir, `run-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("a KOS for Mac rebuild", () => {
  it("gets the few names it needs from the host's environment, never its secrets", async () => {
    const env = childEnv({ HOME: "/Users/me", PATH: "/usr/bin", DISCORD_TOKEN: "secret", KOS_SECRET_TWILIO: "secret", OPENAI_API_KEY: "secret", KOS_DEVICE_SIGNING_KEYCHAIN: "/k" });
    expect(env).toEqual({ HOME: "/Users/me", PATH: "/usr/bin", KOS_DEVICE_SIGNING_KEYCHAIN: "/k", KOS_NODE: process.execPath });
    process.env.DISCORD_TOKEN = "a-token";
    try {
      const out = join(mkdtempSync(join(tmpdir(), "deviceupdates-env-")), "env.txt");
      const installer = macInstaller(tmpdir(), () => undefined, { install: script(`env > "${out}"`) });
      expect(await installer.install(() => undefined)).toEqual({ ok: true });
      const seen = readFileSync(out, "utf8");
      expect(seen).not.toContain("a-token");
      expect(seen).toContain(`KOS_NODE=${process.execPath}`);
      rmSync(join(out, ".."), { recursive: true, force: true });
    } finally {
      delete process.env.DISCORD_TOKEN;
    }
  });

  it("is stopped, all of it, when it runs past its time, and says so", async () => {
    const pidFile = join((dir ||= mkdtempSync(join(tmpdir(), "deviceupdates-test-"))), "child.pid");
    // Time enough for the script to start its child on a loaded machine, and no more.
    const installer = macInstaller(tmpdir(), () => undefined, { install: script(`sleep 30 & echo $! > "${pidFile}"; wait`), timeoutMs: 2_000 });
    expect(await installer.install(() => undefined)).toEqual({ ok: false, why: "the build took longer than 0 minutes and was stopped" });
    // Its own child went with it: the group was ended, not just the script.
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills what ignores TERM once the grace is up, and says it was stopped at the time", async () => {
    const pidFile = join((dir ||= mkdtempSync(join(tmpdir(), "deviceupdates-test-"))), "stubborn.pid");
    const installer = macInstaller(tmpdir(), () => undefined, { install: script(`trap '' TERM; echo $$ > "${pidFile}"; while true; do sleep 1; done`), timeoutMs: 1_500, graceMs: 300 });
    const started = Date.now();
    expect(await installer.install(() => undefined)).toMatchObject({ ok: false, why: expect.stringMatching(/was stopped$/) });
    // Answered at the time, not when (or if) the build ended.
    expect(Date.now() - started).toBeLessThan(1_400 + 1_500);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("says a locked signing key in the owner's words, and otherwise the build's last line", async () => {
    const locked = macInstaller(tmpdir(), () => undefined, { install: script(`echo "Built"; echo "error: errSecInternalComponent" >&2; exit 1`) });
    expect(await locked.install(() => undefined)).toEqual({ ok: false, why: "the signing key is locked, and macOS asks for its PIN only in your own Terminal" });
    const lines: string[] = [];
    const broken = macInstaller(tmpdir(), () => undefined, { install: script(`echo "Compiling"; echo "error: no such module" >&2; exit 1`) });
    expect(await broken.install((l) => lines.push(l))).toEqual({ ok: false, why: "error: no such module" });
    expect(lines).toContain("Compiling");
  });

  it("asks whether signing is set up of the program it is given", async () => {
    expect(await macInstaller(tmpdir(), () => undefined, { signing: script("echo IDENTITY") }).signed()).toBe(true);
    expect(await macInstaller(tmpdir(), () => undefined, { signing: script("exit 1") }).signed()).toBe(false);
  });
});

describe("the builds KOS would hand", () => {
  it("reads KOS for Chrome's stamp again only once the file changed", () => {
    dir = mkdtempSync(join(tmpdir(), "deviceupdates-test-"));
    const stamp = join(dir, "packages", "browser-extension", "dist", "build.json");
    mkdirSync(join(stamp, ".."), { recursive: true });
    writeFileSync(stamp, JSON.stringify({ id: "000000000001", commit: "" }));
    const { expected } = deviceUpdates(dir, () => undefined);
    expect(expected("chrome")?.id).toBe("000000000001");
    writeFileSync(stamp, JSON.stringify({ id: "000000000002", commit: "" }));
    utimesSync(stamp, new Date(), new Date(Date.now() + 5_000));
    expect(expected("chrome")?.id).toBe("000000000002");
  });
});
