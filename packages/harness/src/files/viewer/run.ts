import { execFile, fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { OfficeView } from "@kos/shared";

import { runRequest, type ConvertRequest } from "./convert.js";

/**
 * A conversion run bounded: in a child process of its own, ended on a clock
 * or when its resident memory passes a ceiling. A heap limit alone does not
 * bound a parser, since typed arrays and buffers live outside the heap, so
 * the child's whole resident size is watched from here. Two run at a time;
 * the rest wait their turn.
 */

export const CHILD_HEAP_MB = 512;
export const CHILD_RSS_MB = 1024;
export const CHILD_TIMEOUT_MS = 20_000;
export const CONVERSIONS_AT_ONCE = 2;
const WATCH_MS = 150;

export type Runner = (req: ConvertRequest) => Promise<OfficeView>;

/** At most `slots` of `fn` at once; the rest wait in order. */
export function limited<A extends unknown[], R>(slots: number, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (...args) => {
    if (running >= slots) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await fn(...args);
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** A process's resident size in MB: from /proc on Linux, from ps elsewhere; undefined when it cannot be read. */
function residentMb(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    try {
      const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
      return Promise.resolve(kb ? Number(kb) / 1024 : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }
  return new Promise((resolve) => execFile("/bin/ps", ["-o", "rss=", "-p", String(pid)], (err, out) => resolve(err ? undefined : Number(out.trim()) / 1024 || undefined)));
}

export interface ChildLimits {
  timeoutMs?: number;
  rssMb?: number;
  heapMb?: number;
}

/** A runner that converts each file in a fresh child running `script`. */
export function childRunner(script: string, { timeoutMs = CHILD_TIMEOUT_MS, rssMb = CHILD_RSS_MB, heapMb = CHILD_HEAP_MB }: ChildLimits = {}): Runner {
  return limited(CONVERSIONS_AT_ONCE, (req) =>
    new Promise<OfficeView>((resolve, reject) => {
      const child = fork(script, [], { execArgv: [`--max-old-space-size=${heapMb}`], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        child.kill("SIGKILL");
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`it took more than ${timeoutMs / 1000} s to read, so it was stopped`))), timeoutMs);
      const watch = setInterval(() => {
        if (child.pid === undefined) return;
        void residentMb(child.pid).then((mb) => {
          if (mb !== undefined && mb > rssMb) finish(() => reject(new Error(`it needed more than ${rssMb} MB to read, so it was stopped`)));
        });
      }, WATCH_MS);
      child.on("message", (reply: { ok: true; view: OfficeView } | { ok: false; error: string }) => finish(() => (reply.ok ? resolve(reply.view) : reject(new Error(reply.error)))));
      child.on("error", (err) => finish(() => reject(new Error(`it could not be read: ${err.message}`))));
      child.on("exit", () => finish(() => reject(new Error("its reader stopped before it finished"))));
      child.send(req);
    }),
  );
}

/** The built child beside this file; absent when KOS runs from source (the tests), where conversions run in-process. */
export function builtChild(): string | undefined {
  const path = fileURLToPath(new URL("./child.js", import.meta.url));
  return existsSync(path) ? path : undefined;
}

/** The runner KOS uses: the built child, or in-process when run from source. */
export function defaultRunner(): Runner {
  const script = builtChild();
  return script ? childRunner(script) : limited(CONVERSIONS_AT_ONCE, async (req: ConvertRequest) => runRequest(req));
}
