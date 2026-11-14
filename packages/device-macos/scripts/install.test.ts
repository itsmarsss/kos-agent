import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * install.sh and lock.sh, in a home of their own: the new app renamed into
 * place, a copy a stopped run set aside put back, an app that will not quit
 * left alone and said, and one build at a time.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "install.sh");
let home = "";
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill("SIGKILL");
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

/** An app bundle whose one executable is a script; `marker` says which build it is. */
function app(at: string, marker: string, body = "sleep 30"): string {
  const exe = join(at, "Contents", "MacOS", "KOS for Mac");
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, `#!/bin/sh\n${body}\n`);
  chmodSync(exe, 0o755);
  writeFileSync(join(at, "Contents", "marker"), marker);
  return at;
}

function install(env: Record<string, string> = {}): { status: number | null; stderr: string; opened: string } {
  const built = app(join(home, "build", "KOS for Mac.app"), "new");
  const opened = join(home, "opened");
  const open = join(home, "open.sh");
  writeFileSync(open, `#!/bin/sh\necho "$1" >> "${opened}"\n`);
  chmodSync(open, 0o755);
  const run = spawnSync(SCRIPT, [built], { env: { HOME: home, PATH: process.env.PATH ?? "", KOS_DEVICE_OPEN: open, ...env }, encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, opened: existsSync(opened) ? readFileSync(opened, "utf8") : "" };
}

const installed = (): string => join(home, "Applications", "KOS for Mac.app");
const marker = (): string => readFileSync(join(installed(), "Contents", "marker"), "utf8");

/** The old app, running from where it is installed. */
async function launch(): Promise<void> {
  const child = spawn(join(installed(), "Contents", "MacOS", "KOS for Mac"), { stdio: "ignore" });
  running.push(child);
  await new Promise((r) => setTimeout(r, 200));
}

describe.skipIf(process.platform !== "darwin")("installing KOS for Mac", () => {
  it("puts the new app in place of the old one, renamed in, with nothing left beside it", () => {
    home = mkdtempSync(join(tmpdir(), "install-test-"));
    app(installed(), "old");
    const run = install();
    expect(run.status).toBe(0);
    expect(marker()).toBe("new");
    expect(run.opened.trim()).toBe(installed());
    expect(readdirSync(join(home, "Applications"))).toEqual(["KOS for Mac.app"]);
  });

  it("quits the running one first, as Quit, then replaces it", async () => {
    home = mkdtempSync(join(tmpdir(), "install-test-"));
    app(installed(), "old");
    await launch();
    expect(install().status).toBe(0);
    expect(marker()).toBe("new");
  });

  it("replaces nothing when the running one will not quit, and says why", async () => {
    home = mkdtempSync(join(tmpdir(), "install-test-"));
    app(installed(), "old", "trap '' TERM\nwhile true; do sleep 1; done");
    await launch();
    const run = install();
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/KOS for Mac did not quit within 10 seconds, so nothing was replaced/);
    expect(marker()).toBe("old");
    expect(run.opened).toBe("");
    expect(readdirSync(join(home, "Applications"))).toEqual(["KOS for Mac.app"]);
  }, 20_000);

  it("puts back the copy a run stopped between its renames had set aside, then installs", () => {
    home = mkdtempSync(join(tmpdir(), "install-test-"));
    app(`${installed()}.old`, "old");
    const run = install();
    expect(run.status).toBe(0);
    expect(marker()).toBe("new");
    expect(readdirSync(join(home, "Applications"))).toEqual(["KOS for Mac.app"]);
  });

  it("refuses a home that is not a folder", () => {
    home = mkdtempSync(join(tmpdir(), "install-test-"));
    const run = install({ HOME: "" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/HOME is not set to a folder/);
  });
});

describe("one build at a time", () => {
  const lock = (dir: string): { status: number | null; stderr: string } => {
    const run = spawnSync("bash", ["-c", `source "${join(HERE, "lock.sh")}" && take_lock "${dir}" && cat "${dir}/pid"`], { encoding: "utf8" });
    return { status: run.status, stderr: run.stderr };
  };

  it("is held by a live build, and taken over from one that is gone", async () => {
    home = mkdtempSync(join(tmpdir(), "install-test-"));
    const dir = join(home, ".install.lock");
    // Held by a process that runs: the next build stops, saying so.
    const holder = spawn("sleep", ["30"]);
    running.push(holder);
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), String(holder.pid));
    expect(lock(dir)).toMatchObject({ status: 1, stderr: expect.stringMatching(/Another build of KOS for Mac is running/) });
    // Its holder gone, the lock is stale and taken over.
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    expect(lock(dir).status).toBe(0);
    expect(readFileSync(join(dir, "pid"), "utf8").trim()).not.toBe(String(holder.pid));
  });
});
