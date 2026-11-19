// A headless Chrome a script starts for itself, which never outlives the script or leaves its profile behind.
//
// Chrome runs in a process group of its own, so its helpers go with it. close()
// asks the browser to quit, kills the group if it has not within a grace
// period, waits for it to exit and only then deletes the profile, which Chrome
// writes to until it has gone. The script ending any other way (an uncaught
// error, process.exit, Ctrl-C, a kill) kills the group and deletes the profile
// before it goes. SIGINT and SIGTERM are answered only when the script does
// not answer them itself; when its own handler exits, the same clean-up runs.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** How long Chrome sent SIGTERM has before it is killed. */
const GRACE_MS = 3000;
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

function signalGroup(proc, signal) {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    /* gone */
  }
}

/**
 * What to do, synchronously, for each Chrome still running if the script goes
 * without closing it: nothing asynchronous runs any more by then.
 */
const running = new Set();
const cleanUp = () => {
  for (const kill of running) kill();
};
/** The signals this module answers: only those the script does not answer itself. */
let answered = [];
const onSignal = (signal) => {
  cleanUp();
  process.exit(signal === "SIGINT" ? 130 : 143);
};

function track(kill) {
  if (!running.size) {
    process.on("exit", cleanUp);
    // A script with its own handler decides whether to exit; when it does, "exit" cleans up.
    answered = ["SIGINT", "SIGTERM"].filter((signal) => process.listenerCount(signal) === 0);
    for (const signal of answered) process.on(signal, onSignal);
  }
  running.add(kill);
}

function untrack(kill) {
  running.delete(kill);
  if (running.size) return;
  process.off("exit", cleanUp);
  for (const signal of answered) process.off(signal, onSignal);
  answered = [];
}

/**
 * Start Chrome headless with a throwaway profile (a kos-* folder in the temp
 * folder) and wait for its DevTools endpoint.
 *
 * @param {{ binary?: string, args?: string[], prefix?: string }} [options] extra Chrome flags, and the profile's name prefix
 * @returns {Promise<{ port: number, profile: string, wsUrl: string, close: () => Promise<void> }>}
 */
export async function launchHeadless({ binary = CHROME, args = [], prefix = "kos-headless-" } = {}) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), prefix));
  const proc = spawn(binary, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", ...args, "about:blank"], { stdio: "ignore", detached: true });
  const exited = new Promise((resolve) => {
    proc.once("exit", resolve);
    proc.once("error", resolve);
  });
  if (!proc.pid) {
    rmSync(profile, RM);
    throw new Error(`could not start ${binary}`);
  }

  const killNow = () => {
    signalGroup(proc, "SIGKILL");
    try {
      rmSync(profile, RM);
    } catch {
      /* the next sweep's */
    }
  };
  track(killNow);

  let closing;
  const close = () =>
    (closing ??= (async () => {
      untrack(killNow);
      if (proc.exitCode === null && proc.signalCode === null) {
        // The browser alone first: it closes its own helpers.
        proc.kill("SIGTERM");
        const kill = setTimeout(() => signalGroup(proc, "SIGKILL"), GRACE_MS);
        await exited;
        clearTimeout(kill);
      }
      // A helper that outlived the browser goes with it.
      signalGroup(proc, "SIGKILL");
      await rm(profile, RM);
    })());

  let version;
  for (let i = 0; i < 300 && !version && proc.exitCode === null; i++) {
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => undefined);
    if (!version) await sleep(100);
  }
  if (!version) {
    await close();
    throw new Error("headless Chrome did not start");
  }
  return { port, profile, wsUrl: version.webSocketDebuggerUrl, close };
}
