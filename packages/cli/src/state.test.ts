import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearDaemonState, isKosHostProcess, legacyStatePaths, readDaemonState, statePath, verifyHost, writeDaemonState, type DaemonState } from "./state.js";

describe("daemon state", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kos-state-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const state: DaemonState = { pid: 42, host: "127.0.0.1", port: 4417, workspace: "/w", startedAt: "now", discord: false };

  it("lives under ~/.kos/run, the owner's alone, never in the workspace", () => {
    writeDaemonState("/w", state, home);
    const path = statePath("/w", home);
    expect(path.startsWith(join(home, ".kos", "run"))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".kos", "run")).mode & 0o777).toBe(0o700);
    expect(readDaemonState("/w", home)).toEqual(state);
    expect(readDaemonState("/other", home)).toBeNull();
    clearDaemonState("/w", home);
    expect(readDaemonState("/w", home)).toBeNull();
  });

  it("finds a host from before ~/.kos/run once, and lets the legacy files go when the new state is written", () => {
    const ws = join(home, "ws");
    const [inWorkspace, global] = legacyStatePaths(ws, home) as [string, string];
    mkdirSync(join(ws, ".kos"), { recursive: true });
    mkdirSync(join(home, ".kos"), { recursive: true });
    const old = { ...state, workspace: ws };
    writeFileSync(inWorkspace, JSON.stringify(old));
    writeFileSync(global, JSON.stringify(old));
    expect(readDaemonState(ws, home)).toEqual(old);
    writeDaemonState(ws, { ...old, pid: 43 }, home);
    expect(existsSync(inWorkspace)).toBe(false);
    expect(existsSync(global)).toBe(false);
    expect(readDaemonState(ws, home)?.pid).toBe(43);
  });

  it("takes the legacy global copy only for its own workspace, and leaves another's", () => {
    const [, global] = legacyStatePaths("/w", home) as [string, string];
    mkdirSync(join(home, ".kos"), { recursive: true });
    writeFileSync(global, JSON.stringify({ ...state, workspace: "/elsewhere" }));
    expect(readDaemonState("/w", home)).toBeNull();
    clearDaemonState("/w", home);
    expect(existsSync(global)).toBe(true);
  });
});

describe("verifyHost", () => {
  let server: Server | undefined;
  let auth: string | undefined;
  afterEach(async () => {
    await new Promise((r) => server?.close(r) ?? r(null));
    server = undefined;
  });

  async function kos(answer: object): Promise<number> {
    server = createServer((req, res) => {
      auth = req.headers.authorization;
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }

  it("trusts the host only when its health names the state's pid and workspace", async () => {
    const port = await kos({ ok: true, pid: 42, workspace: "/w" });
    const state: DaemonState = { pid: 42, host: "127.0.0.1", port, workspace: "/w", startedAt: "now", discord: false };
    expect(await verifyHost(state, "t0k")).toEqual({ ok: true, baseUrl: `http://127.0.0.1:${port}` });
    expect(auth).toBe("Bearer t0k");
    expect(await verifyHost({ ...state, pid: 7 }, undefined)).toMatchObject({ ok: false, why: expect.stringMatching(/another KOS \(pid 42/) });
    expect(await verifyHost({ ...state, workspace: "/elsewhere" }, undefined)).toMatchObject({ ok: false });
  });

  it("sends nothing to a host that is not this machine", async () => {
    auth = undefined;
    const check = await verifyHost({ pid: 1, host: "attacker.example", port: 4317, workspace: "/w", startedAt: "now", discord: false }, "t0k");
    expect(check).toEqual({ ok: false, why: "it names attacker.example, which is not this machine" });
    expect(auth).toBeUndefined();
  });
});

describe("isKosHostProcess", () => {
  it("knows a host by this CLI's main.js and its workspace, and nothing else", () => {
    const ps = (line: string | undefined) => () => line;
    expect(isKosHostProcess(1, "/kos/main.js", "/w", ps("node /kos/main.js start --foreground --workspace /w --port 4317"))).toBe(true);
    expect(isKosHostProcess(1, "/kos/main.js", "/w", ps("node /kos/main.js start --foreground --workspace /w2"))).toBe(false);
    expect(isKosHostProcess(1, "/kos/main.js", "/w", ps("/usr/bin/vim notes.txt"))).toBe(false);
    expect(isKosHostProcess(1, "/kos/main.js", "/w", ps(undefined))).toBe(false);
  });
});
