import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { PortTakenError, assertPortFree, awaitOwnHost, portFree } from "./porttaken.js";

const HOST = "127.0.0.1";

/** A free port in the range these tests are allowed, so none lands on a live host. */
async function freePort(): Promise<number> {
  for (let port = 4417; port <= 4431; port++) if (await portFree(HOST, port)) return port;
  throw new Error("no free port in 4417-4431");
}

/** A stand-in for the spawned host: answers health as itself, or hangs, or tries to listen and exits. */
function child(port: number, mode: "serve" | "hang" | "listen-or-exit"): ChildProcess {
  const script = {
    serve: `require("node:http").createServer((q, s) => s.end(JSON.stringify({ ok: true, pid: process.pid, workspace: "/w" }))).listen(${port}, "${HOST}")`,
    hang: "setInterval(() => {}, 1000)",
    "listen-or-exit": `require("node:net").createServer().once("error", () => process.exit(1)).listen(${port}, "${HOST}")`,
  }[mode];
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function track(proc: ChildProcess): ChildProcess {
  closers.push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  });
  return proc;
}

async function hold(server: Server | ReturnType<typeof createTcpServer>, port: number): Promise<void> {
  await new Promise<void>((r) => server.listen(port, HOST, () => r()));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
}

/** Another KOS, of another workspace, already on the port. */
async function otherKos(port: number): Promise<void> {
  const server = createHttpServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, pid: 999_999, discord: false, cron: true, workspace: "/elsewhere" }));
  });
  await hold(server, port);
}

describe("awaitOwnHost", () => {
  it("succeeds once its own child answers on a free port", async () => {
    const port = await freePort();
    const proc = track(child(port, "serve"));
    expect(await awaitOwnHost({ child: proc, host: HOST, port, logPath: "/log" })).toBeNull();
  });

  it("refuses when another KOS holds the port, and stops its child", async () => {
    const port = await freePort();
    await otherKos(port);
    const proc = track(child(port, "hang"));
    const refused = await awaitOwnHost({ child: proc, host: HOST, port, logPath: "/log" });
    expect(refused).toBe(`port ${port} is already in use by another KOS (pid 999999, workspace /elsewhere); stop it or pick --port`);
    expect(proc.signalCode).toBe("SIGTERM");
  });

  it("refuses when a plain TCP server holds the port", async () => {
    const port = await freePort();
    await hold(createTcpServer((socket) => socket.destroy()), port);
    const proc = track(child(port, "listen-or-exit"));
    const refused = await awaitOwnHost({ child: proc, host: HOST, port, logPath: "/log" });
    expect(refused).toBe(`port ${port} is already in use by a process that is not KOS, or a KOS this token cannot reach; stop it or pick --port`);
    expect(proc.exitCode).toBe(1);
  });

  it("leaves a slow child running, and says where the log is", async () => {
    const port = await freePort();
    const proc = track(child(port, "hang"));
    const refused = await awaitOwnHost({ child: proc, host: HOST, port, logPath: "/log", timeoutMs: 500 });
    expect(refused).toBe(`host did not answer within 1s and is left running (pid ${proc.pid}); check /log`);
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();
  });
});

describe("assertPortFree", () => {
  it("passes on a free port and names the KOS holding a taken one", async () => {
    const port = await freePort();
    await assertPortFree(HOST, port);
    await otherKos(port);
    const err = await assertPortFree(HOST, port).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortTakenError);
    expect((err as Error).message).toMatch(/another KOS \(pid 999999, workspace \/elsewhere\)/);
  });
});
