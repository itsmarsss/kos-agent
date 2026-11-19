import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bubblewrap, bwrapCommand } from "./bwrap.js";
import { runCaptured } from "./capture.js";
import { GIT_CONTROL_WRITES, GIT_INFO_ATTRIBUTES } from "./githold.js";
import { jailedCommand, jailedProgram, ownJail, type JailOptions } from "./jail.js";

/** The longest a jailed child in these tests may run before it is killed: none may hang the suite. */
const CHILD_MS = 15_000;

/** The index of a mount in a bwrap command line: the flag and its paths, in order. */
function mountAt(args: string[], ...mount: string[]): number {
  for (let i = 0; i + mount.length <= args.length; i++) if (mount.every((m, j) => args[i + j] === m)) return i;
  return -1;
}

describe("the bubblewrap jail's command line", () => {
  let ws: string;
  const build = (options: Omit<JailOptions, "workspaceRoot">, file = "/bin/sh"): ReturnType<typeof bwrapCommand> =>
    bwrapCommand("/usr/bin/bwrap", file, ["-c", "true"], { workspaceRoot: ws, secretFiles: [], ...options });

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "kos-bwrap-args-")));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("binds the workspace read-only under narrowed writes, hides what is hidden, then opens the writes", () => {
    for (const dir of [".kos/tmp/run", "proj"]) mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, "kos.sqlite"), "db");
    const { args } = build({ writes: [join(ws, ".kos/tmp/run"), join(ws, "proj")], hidden: [join(ws, ".kos"), join(ws, "kos.sqlite"), join(ws, "gone")], network: false });
    expect(args.slice(0, 3)).toEqual(["--unshare-all", "--die-with-parent", "--new-session"]);
    expect(args).not.toContain("--share-net");
    const base = mountAt(args, "--ro-bind", ws, ws);
    const covered = mountAt(args, "--tmpfs", join(ws, ".kos"), "--remount-ro", join(ws, ".kos"));
    const opened = mountAt(args, "--bind", join(ws, ".kos/tmp/run"), join(ws, ".kos/tmp/run"));
    expect(base).toBeGreaterThan(mountAt(args, "--tmpfs", "/tmp"));
    expect(covered).toBeGreaterThan(base);
    expect(opened).toBeGreaterThan(covered);
    expect(mountAt(args, "--ro-bind", "/dev/null", join(ws, "kos.sqlite"))).toBeGreaterThan(base);
    // Nothing there, nothing to cover.
    expect(args).not.toContain(join(ws, "gone"));
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "true"]);
  });

  it("binds the whole workspace writable by default, with the network unless told otherwise", () => {
    const { args } = build({});
    expect(mountAt(args, "--bind", ws, ws)).toBeGreaterThan(-1);
    expect(args).toContain("--share-net");
    expect(build({ network: "local" }).args).not.toContain("--share-net");
    expect(build({ network: false }).args).not.toContain("--share-net");
  });

  it("holds read-only paths over the writable workspace, and carves writable folders back out after", () => {
    mkdirSync(join(ws, ".kos/tmp"), { recursive: true });
    writeFileSync(join(ws, "profile.json"), "{}");
    const { args, release } = build({ readOnly: [join(ws, "profile.json"), join(ws, ".kos")], writableWithin: [join(ws, ".kos/tmp")] });
    try {
      const held = mountAt(args, "--ro-bind", join(ws, ".kos"), join(ws, ".kos"));
      expect(mountAt(args, "--ro-bind", join(ws, "profile.json"), join(ws, "profile.json"))).toBeGreaterThan(mountAt(args, "--bind", ws, ws));
      expect(mountAt(args, "--bind", join(ws, ".kos/tmp"), join(ws, ".kos/tmp"))).toBeGreaterThan(held);
    } finally {
      release?.();
    }
  });

  it("stands in for a read-only file not yet there, for the run's length only", () => {
    const mcp = join(ws, "mcp.json");
    const git = join(ws, ".config", "git");
    const first = build({ readOnly: [mcp, git] });
    const second = build({ readOnly: [mcp] });
    expect(readFileSync(mcp, "utf8")).toBe("{}\n");
    expect(existsSync(git)).toBe(true);
    expect(mountAt(first.args, "--ro-bind", mcp, mcp)).toBeGreaterThan(-1);
    first.release?.();
    // Still the second run's.
    expect(existsSync(mcp)).toBe(true);
    expect(existsSync(join(ws, ".config"))).toBe(false);
    second.release?.();
    expect(existsSync(mcp)).toBe(false);
  });

  it("leaves a stand-in the host has since written, and makes none where the run cannot write", () => {
    const mcp = join(ws, "mcp.json");
    const run = build({ readOnly: [mcp] });
    writeFileSync(mcp, '{"servers":{}}');
    run.release?.();
    expect(readFileSync(mcp, "utf8")).toBe('{"servers":{}}');
    rmSync(mcp);
    mkdirSync(join(ws, "proj"));
    const narrowed = build({ writes: [join(ws, "proj")], readOnly: [mcp] });
    expect(existsSync(mcp)).toBe(false);
    narrowed.release?.();
  });

  it("stands in for a hidden read-only file not yet there, so the run cannot plant it", () => {
    const wal = join(ws, "kos.sqlite-wal");
    const { args, release } = build({ hidden: [wal], readOnly: [wal] });
    try {
      expect(existsSync(wal)).toBe(true);
      expect(mountAt(args, "--ro-bind", "/dev/null", wal)).toBeGreaterThan(mountAt(args, "--bind", ws, ws));
    } finally {
      release?.();
    }
    expect(existsSync(wal)).toBe(false);
  });

  it("covers again what is hidden inside a folder bound back in", () => {
    mkdirSync(join(ws, ".kos", "tmp", "keys"), { recursive: true });
    const keys = join(ws, ".kos", "tmp", "keys");
    const { args } = build({ hidden: [keys], readOnly: [join(ws, ".kos")], writableWithin: [join(ws, ".kos", "tmp")] });
    const carved = mountAt(args, "--bind", join(ws, ".kos", "tmp"), join(ws, ".kos", "tmp"));
    expect(carved).toBeGreaterThan(-1);
    expect(args.lastIndexOf(keys)).toBeGreaterThan(carved);
  });

  it("refuses a read-only path reached through a link, and binds no write through one", () => {
    mkdirSync(join(ws, "real"));
    symlinkSync(join(ws, "real"), join(ws, "linked"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "kos-bwrap-outside-")));
    symlinkSync(outside, join(ws, "proj"));
    try {
      expect(() => build({ readOnly: [join(ws, "linked", "mcp.json")] })).toThrow(/link/);
      const { args } = build({ writes: [join(ws, "proj")] });
      expect(args).not.toContain(join(ws, "proj"));
      expect(args).not.toContain(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("turns the git patterns into mounts: control held, the .git folder pinned, attributes covered", () => {
    const git = join(ws, "repo", ".git");
    for (const dir of ["hooks", "info", "objects"]) mkdirSync(join(git, dir), { recursive: true });
    writeFileSync(join(git, "config"), "[core]\n");
    writeFileSync(join(git, "info", "attributes"), "* diff=x\n");
    writeFileSync(join(ws, "sub.git"), "");
    const { args } = build({ unwritable: GIT_CONTROL_WRITES, unreadable: [GIT_INFO_ATTRIBUTES] });
    const pinned = mountAt(args, "--bind", git, git);
    expect(pinned).toBeGreaterThan(-1);
    expect(mountAt(args, "--ro-bind", join(git, "config"), join(git, "config"))).toBeGreaterThan(pinned);
    const info = mountAt(args, "--ro-bind", join(git, "info"), join(git, "info"));
    expect(info).toBeGreaterThan(pinned);
    expect(mountAt(args, "--ro-bind", join(git, "hooks"), join(git, "hooks"))).toBeGreaterThan(pinned);
    expect(mountAt(args, "--ro-bind", "/dev/null", join(git, "info", "attributes"))).toBeGreaterThan(info);
    expect(args).not.toContain(join(git, "objects"));
    expect(args).not.toContain(join(ws, "sub.git"));
  });

  it("covers KOS's secrets last, where a bind would show them, and binds a program installed elsewhere", () => {
    mkdirSync(join(ws, "vault"));
    const { args } = build({ secretFiles: [join(ws, "vault"), "/nowhere/write.key"] }, "/home/me/.cargo/bin/tectonic");
    expect(mountAt(args, "--tmpfs", join(ws, "vault"))).toBeGreaterThan(mountAt(args, "--bind", ws, ws));
    expect(args).not.toContain("/nowhere/write.key");
    expect(mountAt(args, "--ro-bind-try", "/home/me/.cargo/bin/tectonic", "/home/me/.cargo/bin/tectonic")).toBeGreaterThan(-1);
  });
});

describe("choosing the jail", () => {
  it("prefers bubblewrap on Linux, then the container, and names bubblewrap when it refuses", () => {
    const ws = realpathSync(tmpdir());
    const linux = jailedCommand("ls", { workspaceRoot: ws, platform: "linux", bubblewrap: "/usr/bin/bwrap", contained: true, secretFiles: [] });
    expect(linux.file).toBe("/usr/bin/bwrap");
    expect(linux.args.slice(-3)).toEqual(["/bin/sh", "-c", "ls"]);
    expect(jailedProgram("ls", [], { workspaceRoot: ws, platform: "linux", bubblewrap: false, contained: true })).toEqual({ file: "ls", args: [] });
    expect(() => jailedCommand("ls", { workspaceRoot: ws, platform: "linux", bubblewrap: false, contained: false })).toThrow(/bubblewrap/);
    expect(ownJail("linux", "/usr/bin/bwrap")).toBe(true);
    expect(ownJail("linux", false)).toBe(false);
    expect(ownJail("darwin", false)).toBe(true);
  });

  // The Linux job installs bubblewrap; there it must be found, or the parity tests below would only skip.
  it.runIf(process.env.KOS_EXPECT_BWRAP === "1")("finds a working bubblewrap where one is installed", () => {
    expect(bubblewrap()).toBeDefined();
  });
});

describe.runIf(bubblewrap() !== undefined)("the bubblewrap jail on Linux", { timeout: 60_000 }, () => {
  let ws: string;

  async function run(command: string, options: Omit<JailOptions, "workspaceRoot"> = {}, cwd = ws): Promise<string> {
    const jailed = jailedCommand(command, { workspaceRoot: ws, secretFiles: [], kosPorts: [], ...options });
    const out = await runCaptured(jailed, { cwd, env: { PATH: "/usr/bin:/bin", HOME: ws }, timeoutMs: CHILD_MS, maxOutput: 20_000 });
    return out.stdout.trim();
  }

  async function node(script: string, options: Omit<JailOptions, "workspaceRoot">): Promise<Record<string, string>> {
    const file = join(ws, "probe.mjs");
    writeFileSync(file, script);
    const jailed = jailedProgram(process.execPath, [file], { workspaceRoot: ws, secretFiles: [], kosPorts: [], ...options });
    const out = await runCaptured(jailed, { cwd: ws, env: { PATH: "/usr/bin:/bin", HOME: ws }, timeoutMs: CHILD_MS, maxOutput: 20_000 });
    return JSON.parse(out.stdout.trim()) as Record<string, string>;
  }

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "kos-bwrap-")));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("writes in its home and nowhere else, and sees nothing of the owner's home", async () => {
    mkdirSync(join(ws, "proj"));
    mkdirSync(join(ws, "other"));
    const out = await run("echo a > proj/a && echo wrote; echo b > other/b 2>/dev/null || echo denied; ls " + homedir() + " >/dev/null 2>&1 || echo hidden", { writes: [join(ws, "proj")] });
    expect(out.split("\n")).toEqual(["wrote", "denied", "hidden"]);
    expect(readFileSync(join(ws, "proj", "a"), "utf8")).toBe("a\n");
    expect(existsSync(join(ws, "other", "b"))).toBe(false);
  });

  it("cannot read KOS's own files, a .env or a secret, nor write what is read-only", async () => {
    mkdirSync(join(ws, ".kos"));
    writeFileSync(join(ws, ".kos", "state"), "state");
    writeFileSync(join(ws, "kos.sqlite"), "db");
    writeFileSync(join(ws, ".env"), "KEY=sekrit");
    writeFileSync(join(ws, "write.key"), "key");
    writeFileSync(join(ws, "profile.json"), "{}");
    const hidden = [".kos", "kos.sqlite", ".env"].map((n) => join(ws, n));
    const out = await run("for f in .kos/state kos.sqlite .env write.key; do cat $f 2>/dev/null || echo no; done; echo x > profile.json 2>/dev/null || echo held; echo x > mcp.json 2>/dev/null || echo held", {
      hidden,
      readOnly: [join(ws, "profile.json"), join(ws, "mcp.json")],
      secretFiles: [join(ws, "write.key")],
    });
    expect(out.split("\n")).toEqual(["no", "no", "no", "no", "held", "held"]);
    expect(readFileSync(join(ws, "profile.json"), "utf8")).toBe("{}");
    // The stand-in for mcp.json was taken away when the run ended.
    expect(existsSync(join(ws, "mcp.json"))).toBe(false);
  });

  it("keeps a run off the network, and one kept to this machine on a loopback of its own", async () => {
    const host = createServer((_q, r) => r.end("host"));
    await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
    const port = (host.address() as { port: number }).port;
    const script = `import { createServer } from "node:http";
const tryFetch = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.text(), () => "refused");
const own = createServer((_q, r) => r.end("own"));
await new Promise((done) => own.listen(0, "127.0.0.1", done));
console.log(JSON.stringify({ self: await tryFetch("http://127.0.0.1:" + own.address().port + "/"), host: await tryFetch("http://127.0.0.1:${port}/"), world: await tryFetch("http://1.1.1.1/") }));
own.close();`;
    try {
      for (const network of [false, "local"] as const) {
        expect(await node(script, { network })).toEqual({ self: "own", host: "refused", world: "refused" });
      }
      // Shared only when allowed, and then the host's own ports are there too: see bwrap.ts.
      expect((await node(script, {})).host).toBe("host");
    } finally {
      await new Promise((done) => host.close(done));
    }
  });

  it("keeps git's control unwritable for a run nobody approved, and its objects writable", async () => {
    const repo = join(ws, "repo");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    mkdirSync(join(repo, ".git", "objects"));
    writeFileSync(join(repo, ".git", "config"), "[core]\n");
    const out = await run(
      "echo '[core] fsmonitor=x' >> .git/config 2>/dev/null || echo config; touch .git/hooks/pre-commit 2>/dev/null || echo hooks; mv .git moved 2>/dev/null || echo pinned; touch .git/objects/o && echo objects",
      { unwritable: GIT_CONTROL_WRITES, unreadable: [GIT_INFO_ATTRIBUTES], network: "local" },
      repo,
    );
    expect(out.split("\n")).toEqual(["config", "hooks", "pinned", "objects"]);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toBe("[core]\n");
  });

  it("gives every run a fresh /tmp, gone when it ends", async () => {
    const mark = `kos-bwrap-mark-${process.pid}`;
    expect(await run(`echo x > /tmp/${mark} && cat /tmp/${mark}`)).toBe("x");
    expect(existsSync(join("/tmp", mark))).toBe(false);
    expect(await run(`test -e /tmp/${mark} && echo seen || echo fresh`)).toBe("fresh");
  });
});
