import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { programOf } from "../risk/rules.js";
import { CONFIG_REFUSED, createShellModule, DATABASE_REFUSED, namesDatabase, runShell, type ShellResult } from "./shell.js";

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

  it("tells a command naming KOS's own settings at the root why, and leaves the same names elsewhere alone", () => {
    for (const command of ["echo '{}' > mcp.json", "cp evil.json ./MCP.json", "sed -i '' s/a/b/ profile.json", "rm daemon.json", "cat mcp.json"]) {
      expect(registry.refusal("shell.run", { command }), command).toBe(CONFIG_REFUSED);
    }
    for (const command of ["cat .mcp.json", "cat sites/app/profile.json", "cat ~/.docker/daemon.json", "cat sites/app/package.json"]) {
      expect(registry.refusal("shell.run", { command }), command).toBeUndefined();
    }
  });

  it("cannot write KOS's own settings or database however a command names them", async () => {
    writeFileSync(join(root, "mcp.json"), '{"servers":{}}');
    writeFileSync(join(root, "profile.json"), "{}");
    mkdirSync(join(root, "sites"), { recursive: true });
    for (const command of [
      "echo '{\"servers\":{\"evil\":{}}}' > m*.json",
      "echo x > 'mcp'.json",
      'f=mcp; echo x > "$f.json"',
      "ln -s ../mcp.json sites/link && echo x > sites/link",
      "cd sites && echo x > ../mcp.json",
      "mv mcp.json gone.json",
      "rm -f profile.json",
      "echo x > daemon.json",
      "echo x > kos.sqlite-wal",
    ]) {
      await run({ command });
      expect(readFileSync(join(root, "mcp.json"), "utf8"), command).toBe('{"servers":{}}');
    }
    expect(existsSync(join(root, "profile.json"))).toBe(true);
    expect(existsSync(join(root, "daemon.json"))).toBe(false);
    const wal = join(root, "kos.sqlite-wal");
    expect(existsSync(wal) ? readFileSync(wal, "utf8") : "").not.toBe("x\n");
    // The rest of the workspace is the shell's to write, .kos/tmp included.
    const fine = await run({ command: "echo ok > sites/note.txt && echo ok > \"$TMPDIR/t\" && cat sites/note.txt" });
    expect(fine.stdout.trim()).toBe("ok");
  });

  it("refuses to open KOS's own database, except from Maintenance, which asks", async () => {
    expect(namesDatabase("sqlite3 -readonly kos.sqlite '.schema crons'")).toBe(true);
    expect(namesDatabase("cp kos.sqlite backup/")).toBe(true);
    expect(namesDatabase("ls")).toBe(false);
    expect(registry.refusal("shell.run", { command: "sqlite3 kos.sqlite .tables" })).toBe(DATABASE_REFUSED);
    expect(registry.refusal("shell.run", { command: "sqlite3 kos.sqlite .tables" })).toContain("cron.list");
    expect(registry.refusal("shell.run", { command: "git status" })).toBeUndefined();
    const maintenance = new ToolRegistry();
    const ctx = toolRegistryContext(maintenance, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), callerProject: () => "maintenance" });
    await createShellModule({ timeoutSeconds: 5 }).activate(ctx);
    expect(maintenance.refusal("shell.run", { command: "sqlite3 kos.sqlite .tables" })).toBeUndefined();
    expect(maintenance.classify("shell.run", { command: "sqlite3 -readonly kos.sqlite .tables" }).tier).toBe("risky");
  });

  it("runs none of a repository's own programs on a git read", async () => {
    // Written as the agent could have: a fsmonitor hook and a textconv driver, each leaving a mark.
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "a");
    const hook = join(root, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch "${root}/FSMONITOR"\n`);
    chmodSync(hook, 0o755);
    git("config", "core.fsmonitor", hook);
    git("config", "diff.mark.textconv", `sh -c 'touch "${root}/TEXTCONV"; cat "$0"'`);
    writeFileSync(join(root, ".gitattributes"), "*.t diff=mark\n");
    writeFileSync(join(root, "a.t"), "one\n");
    git("add", "a.t", ".gitattributes");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "b");
    writeFileSync(join(root, "a.t"), "two\n");
    // Unheld, git runs both: the test would see a mark.
    git("status");
    git("diff");
    expect(existsSync(join(root, "FSMONITOR")) && existsSync(join(root, "TEXTCONV"))).toBe(true);
    rmSync(join(root, "FSMONITOR"));
    rmSync(join(root, "TEXTCONV"));

    expect(registry.classify("shell.run", { command: "git status && git diff" }).tier).toBe("safe");
    const status = await run({ command: "git status --short" });
    expect(status.stdout).toContain("a.t");
    const diff = await run({ command: "git diff" });
    expect(diff.stdout).toContain("+two");
    expect(existsSync(join(root, "FSMONITOR"))).toBe(false);
    expect(existsSync(join(root, "TEXTCONV"))).toBe(false);
  });

  it("runs a line judged read-only where a wrong judgement cannot matter: no writes, no network, none of KOS's files", async () => {
    execFileSync("git", ["init", "-q", "projects/x"], { cwd: root });
    const config = readFileSync(join(root, "projects/x/.git/config"), "utf8");
    writeFileSync(join(root, "kos.sqlite"), "db-secret");
    writeFileSync(join(root, "mcp.json"), "mcp-secret");
    writeFileSync(join(root, ".env"), "env-secret");
    writeFileSync(join(root, "notes.txt"), "mine");
    const held = (command: string): Promise<ShellResult> =>
      runShell(command, { workspaceRoot: root, cwd: root, timeoutMs: 5000, maxOutput: 10_000, readOnlyRun: true });
    // The auditor's expansions, as if the judgement had let them through.
    const marks = ["A", "B", "C", "D"].map((m) => join(root, `MARK-${m}`));
    writeFileSync(join(root, "--pre=sh"), "");
    for (const command of [
      `sh -c 'touch ${marks[0]}' {--pre=sh,.}`,
      `X=; sh -c "touch \${X:-${marks[1]}}"`,
      `sh -c $'touch ${marks[2]}'`,
      `for f in *; do :; done; touch ${marks[3]}`,
      "printf '[core]\\n\\tfsmonitor = ./x\\n' >> projects/x/.git/config",
      "echo x > projects/x/.git/hooks/pre-commit",
      "echo x > .gitconfig",
      "echo x > notes.txt",
      "mkdir made",
    ]) {
      await held(command);
    }
    for (const mark of marks) expect(existsSync(mark), mark).toBe(false);
    expect(readFileSync(join(root, "projects/x/.git/config"), "utf8")).toBe(config);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("mine");
    for (const path of ["projects/x/.git/hooks/pre-commit", ".gitconfig", "made"]) expect(existsSync(join(root, path)), path).toBe(false);
    const secrets = await held("cat kos.sqlite mcp.json .env; ls .kos");
    expect(secrets.stdout).not.toMatch(/secret/);
    expect(secrets.stdout).not.toContain("tmp");
    const net = await held("/usr/bin/curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:9 || /usr/bin/nc -z -w 2 1.1.1.1 443 && echo reached");
    expect(net.stdout).not.toContain("reached");
    // Its own temp folder is writable, and gone afterwards.
    const tmp = await held('echo ok > "$TMPDIR/t" && cat "$TMPDIR/t" && cat notes.txt');
    expect(tmp.stdout).toBe("ok\nmine");
    expect(readdirSync(join(root, ".kos", "tmp")).filter((n) => n.startsWith("read-"))).toEqual([]);
  });

  it("lets an approved run init, clone and configure a repository", async () => {
    const line = "git init -q projects/a && cd projects/a && git config user.email a@b && git config user.name a && echo a > a && git add a && git commit -qm a && cd .. && git clone -q a b && git -C b log --oneline";
    expect(registry.classify("shell.run", { command: line }).tier).toBe("risky");
    const r = await run({ command: line });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]+ a$/);
    expect(readFileSync(join(root, "projects/a/.git/config"), "utf8")).toContain("email = a@b");
    expect(existsSync(join(root, "projects/b/.git/config"))).toBe(true);
    // The repository's own hooks run on an approved commit, as the owner's husky would.
    const hook = join(root, "projects/a/.git/hooks/post-commit");
    await run({ command: `printf '#!/bin/sh\\ntouch HOOKED\\n' > ${hook} && chmod +x ${hook} && cd projects/a && git commit -q --allow-empty -m b` });
    expect(existsSync(join(root, "projects/a/HOOKED"))).toBe(true);
  });

  it("is risky by floor, and safe for a line that only reads", () => {
    expect(registry.classify("shell.run", { command: "rm -rf x" }).tier).toBe("risky");
    expect(registry.classify("shell.run", { command: "ls && rm -rf x" }).tier).toBe("risky");
    expect(registry.classify("shell.run", { command: "ls" }).tier).toBe("safe");
    expect(registry.classify("shell.run", { command: "git status && git log -3 | head" }).tier).toBe("safe");
    expect(registry.classify("shell.run", {}).tier).toBe("risky");
  });
});
