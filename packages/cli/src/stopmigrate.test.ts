import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { portFree } from "./porttaken.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** A free port in the range these tests are allowed, from the middle, away from the other suites'. */
async function freePort(): Promise<number> {
  for (let port = 4424; port <= 4431; port++) if (await portFree("127.0.0.1", port)) return port;
  throw new Error("no free port in 4424-4431");
}

const exited = (child: ChildProcess): Promise<void> => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", () => r())));

/*
 * The first `kos stop` (or restart) after an upgrade: the running host wrote
 * its state where hosts used to, in the workspace. It is still found, and
 * still verified before anything is signalled.
 */
describe.skipIf(!existsSync(MAIN))("kos stop with a host from before ~/.kos/run", () => {
  let home: string;
  let ws: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kos-stop-")));
    ws = join(home, "ws");
    mkdirSync(join(ws, ".kos"), { recursive: true });
  });
  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  const legacy = (pid: number, port: number): void =>
    writeFileSync(join(ws, ".kos", "daemon.json"), JSON.stringify({ pid, host: "127.0.0.1", port, workspace: ws, startedAt: "then", discord: false }));

  const stop = (): string => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, KOS_ENV_FILE: join(home, "none.env") };
    delete env.KOS_DASHBOARD_TOKEN;
    const r = spawnSync(process.execPath, [MAIN, "stop", "--workspace", ws], { env, encoding: "utf8", timeout: 30_000 });
    return `${r.stdout}${r.stderr}`;
  };

  it("finds the legacy state, verifies the host answers as it, and stops it", async () => {
    const port = await freePort();
    const kos = spawn(process.execPath, ["-e", `require("node:http").createServer((q, s) => s.end(JSON.stringify({ ok: true, pid: process.pid, workspace: ${JSON.stringify(ws)} }))).listen(${port}, "127.0.0.1", () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(kos);
    await new Promise<void>((r) => kos.stdout!.once("data", () => r()));
    legacy(kos.pid!, port);
    expect(stop()).toMatch(`stopped kos host (was pid ${kos.pid})`);
    await exited(kos);
    expect(kos.signalCode).toBe("SIGTERM");
    expect(existsSync(join(ws, ".kos", "daemon.json"))).toBe(false);
  }, 40_000);

  it("refuses a forged one: a stranger's pid is never signalled", async () => {
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(stranger);
    legacy(stranger.pid!, await freePort());
    expect(stop()).toMatch(`pid ${stranger.pid} is not this workspace's KOS host`);
    expect(stranger.exitCode).toBeNull();
    expect(stranger.signalCode).toBeNull();
    expect(existsSync(join(ws, ".kos", "daemon.json"))).toBe(false);
  }, 40_000);
});
