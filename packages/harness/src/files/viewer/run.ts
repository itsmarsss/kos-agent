import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { OfficeView } from "@kos/shared";

import type { ConvertRequest } from "./convert.js";
import { runJob, type ChildRequest } from "./jobs.js";

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
export type Jobs = (req: ChildRequest, signal?: AbortSignal) => Promise<unknown>;

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
  /** CPU seconds the kernel lets the child have (ulimit -t), past which it is killed whatever it is doing. */
  cpuSeconds?: number;
  slots?: number;
}

/** Resident-size reads that may fail in a row before the child is stopped: what cannot be measured is not let run. */
const WATCH_FAILURES_MAX = 3;
export const CHILD_CPU_SECONDS = 25;

/** A job runner: each job in a fresh child running `script`, under a clock, a CPU limit and a memory ceiling; `signal` ends it early. */
export function childJobs(script: string, { timeoutMs = CHILD_TIMEOUT_MS, rssMb = CHILD_RSS_MB, heapMb = CHILD_HEAP_MB, cpuSeconds = CHILD_CPU_SECONDS, slots = CONVERSIONS_AT_ONCE }: ChildLimits = {}): Jobs {
  return limited(slots, (req: ChildRequest, signal?: AbortSignal) =>
    new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("superseded"));
        return;
      }
      // Through a shell only to set the CPU limit; exec then makes the shell the child itself. The soft
      // limit sends SIGXCPU (said as such); the hard one, a few seconds on, is the kernel's SIGKILL behind it.
      const child = spawn("/bin/sh", ["-c", `ulimit -t ${cpuSeconds + 5} && ulimit -S -t ${cpuSeconds} && exec "$0" "$@"`, process.execPath, `--max-old-space-size=${heapMb}`, script], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
      let settled = false;
      let measuring = false;
      let failures = 0;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        fn();
      };
      const onAbort = (): void => finish(() => reject(new Error("superseded")));
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => finish(() => reject(new Error(`it took more than ${timeoutMs / 1000} s to read, so it was stopped`))), timeoutMs);
      const watch = setInterval(() => {
        // One measurement at a time: a slow ps is not stacked up behind itself.
        if (child.pid === undefined || measuring) return;
        measuring = true;
        void residentMb(child.pid).then((mb) => {
          measuring = false;
          if (mb === undefined) {
            if (++failures >= WATCH_FAILURES_MAX) finish(() => reject(new Error("its memory could not be measured, so it was stopped")));
            return;
          }
          failures = 0;
          if (mb > rssMb) finish(() => reject(new Error(`it needed more than ${rssMb} MB to read, so it was stopped`)));
        });
      }, WATCH_MS);
      child.on("message", (reply: { ok: true; value: unknown } | { ok: false; error: string }) => finish(() => (reply.ok ? resolve(reply.value) : reject(new Error(reply.error)))));
      child.on("error", (err) => finish(() => reject(new Error(`it could not be read: ${err.message}`))));
      child.on("exit", (_code, sig) => finish(() => reject(new Error(sig === "SIGXCPU" ? "it used more than its share of the processor, so it was stopped" : sig === "SIGKILL" ? "its reader was stopped" : "its reader stopped before it finished"))));
      child.send(req);
    }),
  );
}

/** The built child beside this file; absent when KOS runs from source (the tests), where jobs run in-process. */
export function builtChild(): string | undefined {
  const path = fileURLToPath(new URL("./child.js", import.meta.url));
  return existsSync(path) ? path : undefined;
}

/** Jobs as KOS runs them: in the built child, or in-process when run from source. */
export function defaultJobs(slots = CONVERSIONS_AT_ONCE): Jobs {
  const script = builtChild();
  return script ? childJobs(script, { slots }) : limited(slots, async (req: ChildRequest) => runJob(req));
}

/** The Office runner over a set of jobs. */
export function officeRunner(jobs: Jobs): Runner {
  return (req) => jobs(req) as Promise<OfficeView>;
}

/** The runner KOS uses for Office files. */
export function defaultRunner(): Runner {
  return officeRunner(defaultJobs());
}
