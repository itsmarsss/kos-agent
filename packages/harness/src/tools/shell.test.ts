import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { programOf } from "../risk/rules.js";
import { createShellModule, type ShellResult } from "./shell.js";

const onMac = process.platform === "darwin";

describe("naming the program a command runs", () => {
  it("is the first word of one plain command", () => {
    expect(programOf("git status")).toBe("git");
    expect(programOf("  /usr/bin/python3 -c 'print(1)'")).toBe("python3");
    expect(programOf("ls")).toBe("ls");
  });

  it("is nothing for a chain, a pipeline, a substitution or an assignment", () => {
    for (const c of ["git status && rm -rf x", "cat a | sh", "ls; rm x", "echo $(id)", "echo `id`", "X=1 cmd", "a\nb", ""]) {
      expect(programOf(c)).toBeUndefined();
    }
  });
});

describe.runIf(onMac)("shell.run on macOS", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let outsideHome: string;

  async function run(input: Record<string, unknown>): Promise<ShellResult & { isError: boolean; raw: string }> {
    const res = await registry.execute("shell.run", input);
    const parsed = res.isError ? ({} as ShellResult) : (JSON.parse(res.content) as ShellResult);
    return { ...parsed, isError: res.isError, raw: res.content };
  }

  beforeEach(async () => {
    // Under the real home directory, which is what the owner's workspace is,
    // so the test proves the workspace is carved back out of the denied home.
    const base = join(homedir(), ".kos-shell-test");
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, "ws-"));
    ws = Workspace.open(root);
    outsideHome = join(homedir(), ".kos-shell-test", "outside.txt");
    writeFileSync(outsideHome, "private", "utf8");
    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await createShellModule({ timeoutSeconds: 5 }).activate(ctx);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideHome, { force: true });
  });

  it("runs a command in the workspace and hands back what it said", async () => {
    const r = await run({ command: "echo hello && pwd" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.stdout.trim().endsWith(root.replace(/^\/private/, "").split("/").slice(-1)[0]!)).toBe(true);
  });

  it("writes inside the workspace and nowhere else", async () => {
    const inside = await run({ command: "mkdir -p projects && echo ok > projects/note.txt" });
    expect(inside.exitCode).toBe(0);
    expect(existsSync(join(root, "projects", "note.txt"))).toBe(true);

    for (const escape of [join(tmpdir(), `kos-shell-escape-${process.pid}.txt`), `/tmp/kos-shell-escape-${process.pid}.txt`]) {
      const outside = await run({ command: `echo x > ${escape}` });
      expect(outside.exitCode).not.toBe(0);
      expect(existsSync(escape)).toBe(false);
    }
    // TMPDIR is inside the workspace, so a program's scratch lands here.
    const scratch = await run({ command: "echo $TMPDIR && touch $TMPDIR/probe" });
    expect(scratch.exitCode).toBe(0);
    expect(existsSync(join(root, ".kos", "tmp", "probe"))).toBe(true);
  });

  it("cannot read the owner's home outside the workspace", async () => {
    const r = await run({ command: `cat ${outsideHome}` });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/not permitted/i);
    // HOME is the workspace, so a tool that reads its config reads it there.
    const home = await run({ command: "echo $HOME" });
    expect(home.stdout.trim().endsWith(root.split("/").slice(-1)[0]!)).toBe(true);
  });

  it("runs in a subdirectory when asked, and never outside the jail", async () => {
    mkdirSync(join(root, "projects", "site"), { recursive: true });
    const r = await run({ command: "basename $(pwd)", cwd: "projects/site" });
    expect(r.stdout.trim()).toBe("site");
    expect((await run({ command: "ls", cwd: "../.." })).isError).toBe(true);
    expect((await run({ command: "ls", cwd: "/etc" })).isError).toBe(true);
  });

  it("kills a run that goes on too long and says so", async () => {
    const r = await run({ command: "sleep 30", timeout: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("keeps output within bounds", async () => {
    const registry2 = new ToolRegistry();
    const ctx = toolRegistryContext(registry2, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await createShellModule({ maxOutput: 100 }).activate(ctx);
    const res = await registry2.execute("shell.run", { command: "yes | head -c 5000" });
    const r = JSON.parse(res.content) as ShellResult;
    expect(r.stdout.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it("is risky by floor", () => {
    expect(registry.classify("shell.run", { command: "ls" }).tier).toBe("risky");
  });
});
