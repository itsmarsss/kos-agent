// A headless Chrome a script starts for itself, which never outlives the script or leaves its profile behind.
//
// Chrome runs in a process group of its own, so its helpers go with it. close()
// stops the group, waits for it to exit and only then deletes the profile, which
// Chrome writes to until it has gone. The script ending any other way (an
// uncaught error, process.exit, Ctrl-C, a kill) kills the group and deletes
// the profile before it goes.

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
 * Start Chrome headless with a throwaway profile (a kos-* folder in the temp
 * folder) and wait for its DevTools endpoint.
 *
 * @param {{ binary?: string, args?: string[], prefix?: string }} [options] extra Chrome flags, and the profile's name prefix
 * @returns {Promise<{ port: number, profile: string, wsUrl: string, close: () => Promise<void> }>}
 */
export async function launchHeadless({ binary = CHROME, args = [], prefix = "kos-headless-" } = {}) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), prefix));
  const proc = spawn(binary, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", ...args, "about:blank"], { stdio: "ignore", detached: true });
  const exited = new Promise((resolve) => {
    proc.once("exit", resolve);
    proc.once("error", resolve);
  });

  // The script going without close(): nothing asynchronous runs any more, so the kill and the delete are synchronous.
  const onExit = () => {
    signalGroup(proc, "SIGKILL");
    try {
      rmSync(profile, RM);
    } catch {
      /* the next sweep's */
    }
  };
  const onSignal = (signal) => {
    onExit();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("exit", onExit);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let closing;
  const close = () =>
    (closing ??= (async () => {
      process.off("exit", onExit);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (proc.exitCode === null && proc.signalCode === null) {
        signalGroup(proc, "SIGTERM");
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
