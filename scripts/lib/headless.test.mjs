import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const script = ({ before = "", end }) => `
import { launchHeadless } from ${JSON.stringify(fileURLToPath(new URL("./headless.mjs", import.meta.url)))};
${before}
const chrome = await launchHeadless({ binary: ${JSON.stringify(binary)}, prefix: "kos-headless-test-" });
console.log(chrome.profile);
${end}
`;
  const idle = "setInterval(() => {}, 1000);";

  it("fails at once when the binary cannot be started, and leaves no profile", async () => {
    const started = Date.now();
    const prefix = `kos-headless-test-${process.pid}-`;
    await expect(launchHeadless({ binary: join(dir, "no-such-chrome"), prefix })).rejects.toThrow(/could not start/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readdirSync(tmpdir()).some((name) => name.startsWith(prefix))).toBe(false);
  });

  it.each([
    ["SIGTERM", "SIGTERM", () => ({ end: idle })],
    ["SIGINT", "SIGINT", () => ({ end: idle })],
    ["an uncaught error", undefined, () => ({ end: "setTimeout(() => { throw new Error('boom'); }, 200);" })],
    // Its own handler is left to answer, and its exit cleans up.
    ["SIGTERM to its own handler", "SIGTERM", () => ({ before: `process.on("SIGTERM", () => { console.log("handled"); process.exit(0); });`, end: idle })],
  ])("goes with a script ended by %s", async (how, signal, parts) => {
    const file = join(dir, "script.mjs");
    writeFileSync(file, script(parts()));
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (data) => (out += data));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await vi.waitFor(() => expect(out).toContain("\n"));
    const profile = out.trim();
    expect(existsSync(profile)).toBe(true);
    await vi.waitFor(() => expect(existsSync(pidsFile)).toBe(true));
    const [browser, helper] = pids();
    if (signal) child.kill(signal);
    const code = await exited;
    if (how.endsWith("own handler")) {
      expect(out).toContain("handled");
      expect(code).toBe(0);
    }
    expect(existsSync(profile)).toBe(false);
    await vi.waitFor(() => expect(running(browser) || running(helper)).toBe(false));
  }, 15_000);
});
