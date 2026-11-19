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
 * first makes a user and network namespace of the run's own (unshare),
 * gives it a NAT through pasta or slirp4netns with the host's loopback out
 * of reach, and only then, inside it, starts bwrap, which shares that
 * network and nothing of the host's.
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
  /** unshare, which makes a networked run's own namespaces. */
  unshare: string;
  /** prlimit, to cap what the run can take; absent where there is none. */
  prlimit?: string;
  command: string[];
}

/** Address the sandbox asks for names at; pasta forwards it to the host's own resolver. */
const PASTA_DNS = "192.0.2.53";
const SLIRP_DNS = "10.0.2.3";

/** Caps on what a run may take: no core files, files to 8 GiB, a few thousand processes. */
const LIMITS = ["--core=0", `--fsize=${8 * 1024 ** 3}`, "--nproc=4096"];

export const NEEDS_NAT =
  "this run needs the network, which the Linux jail gives only through a NAT of its own: install pasta (the passt package) or slirp4netns, and let unshare make user namespaces (see docs/setup.md)";

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

/** Start the NAT on a process's namespaces, and resolve once it is ready; the result stops it. */
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

/** Map a process's new user namespace to the owner's own ids, one to one, with no setgroups. */
function mapIds(pid: number): void {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  writeFileSync(`/proc/${pid}/setgroups`, "deny");
  writeFileSync(`/proc/${pid}/uid_map`, `${uid} ${uid} 1\n`);
  writeFileSync(`/proc/${pid}/gid_map`, `${gid} ${gid} 1\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Wait until a process is in a user namespace other than this one: unshare has made it. */
async function unshared(pid: number): Promise<void> {
  const own = readlinkSync("/proc/self/ns/user");
  for (let i = 0; i < 500; i++) {
    if (readlinkSync(`/proc/${pid}/ns/user`) !== own) return;
    await sleep(10);
  }
  throw new Error("unshare did not make the run's namespaces in time");
}

/** Run a child to its end, passing on the signals that would end this process; resolves to a shell's exit code. */
function supervise(child: ReturnType<typeof spawn>): Promise<number> {
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, forward);
  return new Promise<number>((resolve) => {
    child.once("error", (err) => fail(`${err.message}`));
    // A shell's convention for a program ended by a signal: 128 and its number.
    child.once("close", (code, signal) => resolve(code ?? 128 + (signal ? os.signals[signal] : 0)));
  });
}

/**
 * A networked run, outside: namespaces of its own through unshare, holding
 * this helper again, which waits at the gate; mapped, given its NAT, and
 * only then let through.
 */
async function networked(plan: JailPlan & { nat: JailNat }): Promise<number> {
  const scratch = mkdtempSync(join(plan.scratch, "run-"));
  let stopNat: (() => void) | undefined;
  try {
    const gate = join(scratch, "gate");
    if (spawnSync(plan.mkfifo, ["-m", "600", gate], { stdio: "ignore", timeout: 5000 }).status !== 0) throw new Error("could not make the gate a networked run waits on");
    const inner = spawn(plan.unshare, ["--user", "--net", "--", process.execPath, ...process.execArgv, process.argv[1]!, "--inner", gate, JSON.stringify(plan)], { stdio: "inherit" });
    const ended = supervise(inner);
    try {
      await unshared(inner.pid!);
      mapIds(inner.pid!);
      // Now and then the NAT is refused the namespaces while they settle; the run waits, so it is tried again.
      for (let tries = 1; !stopNat; tries++) {
        try {
          stopNat = await startNat(plan.nat, inner.pid!, scratch);
        } catch (err) {
          if (tries >= 5) throw err;
          await sleep(50 * tries);
        }
      }
    } catch (err) {
      // Not let through without its network: ended, and only then reported, so nothing it holds outlives the helper.
      inner.kill("SIGKILL");
      await ended;
      fail((err as Error).message);
    }
    writeFileSync(gate, "go");
    return await ended;
  } finally {
    stopNat?.();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** bwrap itself: every source opened exactly and handed over by descriptor, the filter too. */
async function jailed(plan: JailPlan): Promise<number> {
  const scratch = mkdtempSync(join(plan.scratch, "run-"));
  const fds: number[] = [];
  try {
    for (const source of plan.sources) fds.push(openExact(source.path, source.dir));
    fds.push(openExact(plan.seccomp, false));
    const at = (i: number): number => 3 + i;
    const args = plan.args.map((a) => (typeof a === "number" ? String(at(a)) : a));
    args.push("--seccomp", String(at(plan.sources.length)));
    if (plan.nat) {
      const resolv = join(scratch, "resolv.conf");
      writeFileSync(resolv, `nameserver ${plan.nat.tool === "pasta" ? PASTA_DNS : SLIRP_DNS}\n`);
      fds.push(openExact(resolv, false));
      // The network is the run's own namespace, which this helper is already in.
      args.push("--share-net", "--ro-bind-fd", String(at(fds.length - 1)), "/etc/resolv.conf");
    }
    const stdio: StdioOptions = ["inherit", "inherit", "inherit", ...fds];
    const [file, ...rest] = plan.prlimit ? [plan.prlimit, ...LIMITS, plan.bwrap] : [plan.bwrap];
    const child = spawn(file!, [...rest, ...args, ...plan.command], { stdio });
    for (const fd of fds.splice(0)) closeSync(fd);
    return await supervise(child);
  } finally {
    for (const fd of fds) closeSync(fd);
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function runPlan(plan: JailPlan): Promise<number> {
  if (plan.networked && !plan.nat) fail(NEEDS_NAT);
  return plan.nat ? networked({ ...plan, nat: plan.nat }) : jailed(plan);
}

if (process.argv[1] && /jailrun\.[jt]s$/.test(process.argv[1])) {
  const [first, gate, inner] = process.argv.slice(2);
  // Inside a networked run's namespaces: through the gate once the NAT is up, then into bwrap.
  const run = first === "--inner" && gate && inner ? (readFileSync(gate), jailed(JSON.parse(inner) as JailPlan)) : first ? runPlan(JSON.parse(first) as JailPlan) : undefined;
  run?.then(
    (code) => process.exit(code),
    (err: Error) => fail(err.message),
  );
}
