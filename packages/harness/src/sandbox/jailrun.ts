import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants as os } from "node:os";
import { join } from "node:path";

/**
 * The process between KOS and bubblewrap: `node jailrun.js <plan>`.
 *
 * Every jailed program on Linux is started through it, by the shell and the
 * MCP servers alike, because what it does needs a process at spawn time.
 * It opens each folder and file to be bound without following a link and
 * checks the opened file is the one named, then hands bwrap the descriptor,
 * so nothing swapped in after the jail was planned is what gets mounted. It
 * passes the seccomp filter the same way. And for a run with the network it
 * starts bwrap blocked, gives the sandbox's own network namespace a NAT of
 * its own through pasta or slirp4netns, with the host's loopback out of
 * reach, and only then lets it go on.
 *
 * Self-contained: it imports nothing of KOS, so it runs from its source
 * (type-stripped) or its build alike.
 */

export interface JailNat {
  tool: "pasta" | "slirp4netns";
  path: string;
}

export interface JailPlan {
  bwrap: string;
  /** bwrap's arguments before the command; a number n stands for the descriptor of sources[n]. */
  args: Array<string | number>;
  /** What is bound by descriptor: opened with no link anywhere in it. */
  sources: Array<{ path: string; dir: boolean }>;
  /** A file holding the seccomp filter. */
  seccomp: string;
  /** A folder only KOS's user can enter, for the run's own scratch. */
  scratch: string;
  /** True when the run has the network: through nat, or not at all. */
  networked: boolean;
  nat?: JailNat;
  /** mkfifo, for the gate a networked run waits on until its NAT is up. */
  mkfifo: string;
  /** prlimit, to cap what the run can take; absent where there is none. */
  prlimit?: string;
  command: string[];
}

/** Address the sandbox asks for names at; pasta forwards it to the host's own resolver. */
const PASTA_DNS = "192.0.2.53";
const SLIRP_DNS = "10.0.2.3";

/** Caps on what a run may take: no core files, files to 8 GiB, a few thousand processes. */
const LIMITS = ["--core=0", `--fsize=${8 * 1024 ** 3}`, "--nproc=4096"];

export const NEEDS_NAT = "this run needs the network, which the Linux jail gives only through a NAT of its own: install pasta (the passt package) or slirp4netns";

/**
 * Open a path that must be exactly itself: no link at its end, and, read
 * back from the kernel, the place it opened is the place named, so no link
 * further up led it elsewhere.
 */
export function openExact(path: string, dir: boolean): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (dir ? constants.O_DIRECTORY : 0));
  let at: string;
  try {
    // Linux says where a descriptor is; bwrap runs nowhere else, and elsewhere this only serves its tests.
    at = process.platform === "linux" ? readlinkSync(`/proc/self/fd/${fd}`) : realpathSync(path);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  if (at !== path) {
    closeSync(fd);
    throw new Error(`${path} is reached through a link (it opened ${at}); the jail will not bind it`);
  }
  return fd;
}

function fail(message: string): never {
  process.stderr.write(`kos jail: ${message}\n`);
  process.exit(126);
}

/** Start the NAT on the sandbox's namespaces, and resolve once it is ready; the result stops it. */
async function startNat(nat: JailNat, pid: number, scratch: string): Promise<() => void> {
  if (nat.tool === "pasta") {
    const pidFile = join(scratch, "pasta.pid");
    // No ports from or to the host, the host's loopback not mapped in: what is left is the outside, through NAT.
    const run = spawnSync(
      nat.path,
      ["--quiet", "--config-net", "-t", "none", "-u", "none", "-T", "none", "-U", "none", "--no-map-gw", "--dns-forward", PASTA_DNS, "--pid", pidFile, String(pid)],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 10_000 },
    );
    if (run.status !== 0) throw new Error(`pasta did not start: ${run.stderr?.trim() || run.error?.message || run.status}`);
    const daemon = Number(readFileSync(pidFile, "utf8").trim());
    return () => {
      try {
        process.kill(daemon, "SIGTERM");
      } catch {
        // Gone with the namespace already.
      }
    };
  }
  const slirp = spawn(nat.path, ["--configure", "--mtu=65520", "--disable-host-loopback", "--ready-fd=3", "--exit-fd=4", `--userns-path=/proc/${pid}/ns/user`, String(pid), "tap0"], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  let said = "";
  slirp.stderr?.on("data", (d: Buffer) => (said += d.toString()));
  await new Promise<void>((ready, failed) => {
    const timer = setTimeout(() => failed(new Error("slirp4netns did not start in time")), 10_000);
    slirp.stdio[3]?.once("data", () => {
      clearTimeout(timer);
      ready();
    });
    slirp.once("exit", (code) => {
      clearTimeout(timer);
      failed(new Error(`slirp4netns did not start: ${said.trim() || code}`));
    });
  });
  return () => {
    slirp.stdio[4]?.destroy();
    slirp.kill("SIGTERM");
  };
}

/** Read bwrap's info: the sandbox's pid, once it exists. */
function childPid(stream: NodeJS.ReadableStream): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.on("data", (d: Buffer) => {
      text += d.toString();
      const m = /"child-pid"\s*:\s*(\d+)/.exec(text);
      if (m) resolve(Number(m[1]));
    });
    stream.once("end", () => reject(new Error("bwrap ended before it said where the sandbox is")));
  });
}

/** Wait until bwrap has mapped the sandbox's user namespace: a NAT that joins it sooner cannot enter its network. */
async function mapped(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      if (["uid_map", "gid_map"].every((map) => readFileSync(`/proc/${pid}/${map}`, "utf8").trim())) return;
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
}

export async function runPlan(plan: JailPlan): Promise<number> {
  if (plan.networked && !plan.nat) fail(NEEDS_NAT);
  const scratch = mkdtempSync(join(plan.scratch, "run-"));
  const fds: number[] = [];
  let stopNat: (() => void) | undefined;
  try {
    for (const source of plan.sources) fds.push(openExact(source.path, source.dir));
    fds.push(openExact(plan.seccomp, false));
    const at = (i: number): number => 3 + i;
    const args = plan.args.map((a) => (typeof a === "number" ? String(at(a)) : a));
    args.push("--seccomp", String(at(plan.sources.length)));
    const stdio: StdioOptions = ["inherit", "inherit", "inherit", ...fds];
    let info = -1;
    let gate = "";
    if (plan.nat) {
      const resolv = join(scratch, "resolv.conf");
      writeFileSync(resolv, `nameserver ${plan.nat.tool === "pasta" ? PASTA_DNS : SLIRP_DNS}\n`);
      fds.push(openExact(resolv, false));
      stdio.push(fds[fds.length - 1]!);
      args.push("--ro-bind-fd", String(stdio.length - 1), "/etc/resolv.conf");
      // bwrap waits on a FIFO, not a pipe of Node's: those are non-blocking past the first three, and it would not wait.
      gate = join(scratch, "gate");
      const made = spawnSync(plan.mkfifo, ["-m", "600", gate], { stdio: "ignore", timeout: 5000 });
      if (made.status !== 0) throw new Error("could not make the gate a networked run waits on");
      fds.push(openSync(gate, constants.O_RDWR));
      stdio.push(fds[fds.length - 1]!);
      const block = stdio.length - 1;
      info = stdio.length;
      stdio.push("pipe");
      args.push("--info-fd", String(info), "--block-fd", String(block));
    }
    const [file, ...rest] = plan.prlimit ? [plan.prlimit, ...LIMITS, plan.bwrap] : [plan.bwrap];
    const child = spawn(file!, [...rest, ...args, ...plan.command], { stdio });
    for (const fd of fds) closeSync(fd);
    fds.length = 0;
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, forward);
    const ended = new Promise<number>((resolve) => {
      child.once("error", (err) => fail(`bwrap did not start: ${err.message}`));
      // A shell's convention for a program ended by a signal: 128 and its number.
      child.once("close", (code, signal) => resolve(code ?? 128 + (signal ? os.signals[signal] : 0)));
    });
    if (plan.nat) {
      const pid = await childPid(child.stdio[info] as NodeJS.ReadableStream);
      await mapped(pid);
      // Now and then the NAT is refused the sandbox's namespaces while bwrap is still setting it up; the sandbox waits, so it is tried again.
      for (let tries = 1; !stopNat; tries++) {
        try {
          stopNat = await startNat(plan.nat, pid, scratch);
        } catch (err) {
          if (tries < 5) {
            await new Promise((done) => setTimeout(done, 50 * tries));
            continue;
          }
          child.kill("SIGKILL");
          fail((err as Error).message);
        }
      }
      writeFileSync(gate, "go");
    }
    return await ended;
  } finally {
    for (const fd of fds) closeSync(fd);
    stopNat?.();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && /jailrun\.[jt]s$/.test(process.argv[1]) && process.argv[2]) {
  runPlan(JSON.parse(process.argv[2]) as JailPlan).then(
    (code) => process.exit(code),
    (err: Error) => fail(err.message),
  );
}
