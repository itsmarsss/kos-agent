import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launchHeadless } from "./headless.mjs";

/**
 * A script's Chrome goes with the script, helpers and profile too, however
 * the script ends. Chrome is played by a stand-in that answers on its
 * DevTools port and, like the worst Chrome, ignores SIGTERM and keeps a helper
 * that ignores it as well.
 */

const FAKE = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const port = Number(process.argv.find((a) => a.startsWith("--remote-debugging-port=")).split("=")[1]);
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.FAKE_PIDS, process.pid + " " + helper.pid);
createServer((_req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser/fake" }))).listen(port, "127.0.0.1");
`;

const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a script's headless Chrome", () => {
  let dir;
  let binary;
  let pidsFile;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headless-test-"));
    binary = join(dir, "chrome");
    writeFileSync(binary, FAKE);
    chmodSync(binary, 0o755);
    pidsFile = join(dir, "pids");
    process.env.FAKE_PIDS = pidsFile;
  });
  afterEach(() => {
    delete process.env.FAKE_PIDS;
    rmSync(dir, { recursive: true, force: true });
  });

  const pids = () => readFileSync(pidsFile, "utf8").split(" ").map(Number);

  it("close kills the whole group, waits for it to exit, then deletes the profile", async () => {
    const chrome = await launchHeadless({ binary, prefix: "kos-headless-test-" });
    expect(chrome.wsUrl).toBe(`ws://127.0.0.1:${chrome.port}/devtools/browser/fake`);
    expect(existsSync(chrome.profile)).toBe(true);
    await vi.waitFor(() => expect(existsSync(pidsFile)).toBe(true));
    const [browser, helper] = pids();
    await chrome.close();
    expect(running(browser)).toBe(false);
    await vi.waitFor(() => expect(running(helper)).toBe(false));
    expect(existsSync(chrome.profile)).toBe(false);
  }, 15_000);

  /** A script that starts one and then ends as it is told, printing its profile once the Chrome is up. */
  const SCRIPT = (end) => `
import { launchHeadless } from ${JSON.stringify(fileURLToPath(new URL("./headless.mjs", import.meta.url)))};
const chrome = await launchHeadless({ binary: ${JSON.stringify(binary)}, prefix: "kos-headless-test-" });
console.log(chrome.profile);
${end}
`;

  it.each([
    ["SIGTERM", "setInterval(() => {}, 1000);"],
    ["SIGINT", "setInterval(() => {}, 1000);"],
    ["an uncaught error", "setTimeout(() => { throw new Error('boom'); }, 200);"],
  ])("goes with a script ended by %s", async (how, end) => {
    const script = join(dir, "script.mjs");
    writeFileSync(script, SCRIPT(end));
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const profile = await new Promise((resolve) => child.stdout.once("data", (data) => resolve(String(data).trim())));
    expect(existsSync(profile)).toBe(true);
    await vi.waitFor(() => expect(existsSync(pidsFile)).toBe(true));
    const [browser, helper] = pids();
    if (how.startsWith("SIG")) child.kill(how);
    await exited;
    expect(existsSync(profile)).toBe(false);
    await vi.waitFor(() => expect(running(browser) || running(helper)).toBe(false));
  }, 15_000);
});
