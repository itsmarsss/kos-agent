import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { BootBox, HOST_WAIT_MS, StillStartingError, awaitNewHost, backoffMs, launchdStep, portClaim, restartArgs, retryableLogin, startSurface, stopWithin, whenUp, type HostSeen } from "./lifecycle.js";

describe("portClaim", () => {
  let claimed: Server | undefined;
  afterEach(async () => {
    claimed?.closeAllConnections();
    await new Promise((r) => claimed?.close(r) ?? r(null));
    claimed = undefined;
  });

  it("answers 503 while KOS boots, then hands every request to the dashboard", async () => {
    const claim = portClaim({});
    claimed = claim.server;
    await new Promise<void>((r) => claim.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(claim.server.address() as AddressInfo).port}/api/health`;
    const booting = await fetch(url);
    expect(booting.status).toBe(503);
    expect(await booting.json()).toEqual({ ok: false, error: "KOS is starting" });
    claim.attach(
      createServer((req, res) => res.end(`dashboard ${req.url}`)),
      () => undefined,
    );
    expect(await (await fetch(url)).text()).toBe("dashboard /api/health");
  });
});

describe("BootBox", () => {
  it("holds what is asked before boot and runs it in order once the value is set", () => {
    const box = new BootBox<{ n: number }>();
    const seen: string[] = [];
    box.when((v) => seen.push(`a${v.n}`));
    box.when((v) => seen.push(`b${v.n}`));
    expect(seen).toEqual([]);
    expect(() => box.get()).toThrow(StillStartingError);
    box.set({ n: 1 });
    expect(seen).toEqual(["a1", "b1"]);
    box.when((v) => seen.push(`c${v.n}`));
    expect(seen).toEqual(["a1", "b1", "c1"]);
    expect(box.get().n).toBe(1);
  });
});

describe("whenUp", () => {
  it("refuses every call in it, nested ones too, until ready stops throwing", () => {
    let up = false;
    const deps = whenUp({ a: () => 1, nested: { b: (x: number) => x + 1 }, label: "kept" }, () => {
      if (!up) throw new StillStartingError();
    });
    expect(() => deps.a()).toThrow(/still starting/);
    expect(() => deps.nested.b(1)).toThrow(/still starting/);
    expect(deps.label).toBe("kept");
    up = true;
    expect(deps.a()).toBe(1);
    expect(deps.nested.b(1)).toBe(2);
  });
});

describe("startSurface", () => {
  it("marks a surface that fails unhealthy with why, and one that starts well again", async () => {
    const seen: [string, string, boolean, string | null][] = [];
    const lines: string[] = [];
    const deps = { health: { observe: (k: string, l: string, ok: boolean, e: string | null) => seen.push([k, l, ok, e]) }, log: (l: string) => lines.push(l) };
    const refused = new Error("An invalid token was provided.");
    expect(await startSurface("Discord", () => Promise.reject(refused), deps)).toEqual({ started: false, error: refused });
    expect(seen[0]).toEqual(["surface:discord", "Discord", false, "did not start: An invalid token was provided."]);
    expect(lines[0]).toMatch(/^Discord: not started \(An invalid token was provided\.\)/);
    expect(await startSurface("Discord", async () => undefined, deps)).toEqual({ started: true });
    expect(seen[1]).toEqual(["surface:discord", "Discord", true, null]);
  });
});

describe("a Discord login that failed", () => {
  it("is tried again when the network failed it, never when the credentials did", () => {
    const coded = Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" });
    expect(retryableLogin(coded)).toBe(true);
    expect(retryableLogin(new Error("Connect Timeout Error"))).toBe(true);
    expect(retryableLogin(new Error("read ECONNRESET"))).toBe(true);
    expect(retryableLogin(new Error("An invalid token was provided."))).toBe(false);
    expect(retryableLogin(new Error("Used disallowed intents"))).toBe(false);
    expect(retryableLogin(new Error("something else"))).toBe(false);
  });

  it("waits longer each time, up to 15 minutes", () => {
    expect([0, 1, 2, 10].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 900_000]);
  });
});

describe("stopWithin", () => {
  it("runs every step in order, and names those that threw, hung, or had no time left", async () => {
    const ran: string[] = [];
    const left = await stopWithin(
      [
        ["daemons", () => void ran.push("daemons")],
        ["discord", () => Promise.reject(new Error("gateway gone"))],
        ["chrome", () => new Promise(() => undefined)],
        ["sites", () => void ran.push("sites")],
      ],
      200,
    );
    expect(ran).toEqual(["daemons"]);
    expect(left).toEqual(["discord (gateway gone)", "chrome (still going at the deadline)", "sites (no time left)"]);
  });
});

describe("restartArgs", () => {
  it("keeps the flags a host was started with", () => {
    expect(restartArgs("/m.js", { rootDir: "/w", host: "127.0.0.1", port: 4417, discord: false, sitesPort: 0 })).toEqual([
      "/m.js",
      "restart",
      "--workspace",
      "/w",
      "--host",
      "127.0.0.1",
      "--port",
      "4417",
      "--no-discord",
      "--sites-port",
      "0",
    ]);
    expect(restartArgs("/m.js", { rootDir: "/w", host: "::1", port: 1, requireDiscord: true })).toContain("--discord");
  });
});

describe("a restart under launchd", () => {
  const WS = "/Users/owner/kos-workspace";
  /** A clock that moves only when the wait sleeps, and a port that answers as `answers` says at each moment. */
  const host = (answers: (at: number) => HostSeen | undefined) => {
    let at = 0;
    const probed: number[] = [];
    return {
      probed,
      run: (before: number | undefined, timeoutMs = HOST_WAIT_MS) =>
        awaitNewHost({
          probe: async () => (probed.push(at), answers(at)),
          workspace: WS,
          before,
          timeoutMs,
          now: () => at,
          sleep: async (ms) => void (at += ms),
        }),
    };
  };

  it("is a restart once this workspace's host answers under a new pid, however long a cold boot takes within the wait", async () => {
    // The old host still answers for 2 s, nothing while the new one boots, then it does at 40 s: past the 15 s the wait once was.
    const h = host((at) => (at < 2_000 ? { pid: 100, workspace: WS } : at < 40_000 ? undefined : { pid: 200, workspace: WS }));
    expect(await h.run(100)).toEqual({ ok: true, pid: 200 });
    expect(h.probed.at(-1)).toBe(40_000);
  });

  it("is not a restart while only the old host answers, and says so", async () => {
    expect(await host(() => ({ pid: 100, workspace: WS })).run(100, 5_000)).toEqual({ ok: false, why: "only the host from before answered (pid 100)" });
  });

  it("is not a restart when another workspace's host holds the port, or nothing answers", async () => {
    expect(await host(() => ({ pid: 300, workspace: "/tmp/scratch" })).run(100, 5_000)).toEqual({ ok: false, why: "another workspace's host answered (pid 300, /tmp/scratch)" });
    const silent = host(() => undefined);
    expect(await silent.run(100, 5_000)).toEqual({ ok: false, why: "nothing answered" });
    // Bounded: it probes until the wait is out, and once more at the end.
    expect(silent.probed.at(-1)).toBe(5_000);
  });

  it("takes any pid of this workspace's when nothing ran before", async () => {
    expect(await host(() => ({ pid: 100, workspace: WS })).run(undefined)).toEqual({ ok: true, pid: 100 });
  });

  it("starts the host unless launchd already brought one back under a new pid", () => {
    expect(launchdStep(undefined, 100)).toBe("kickstart");
    // Still the old one: stop could not end it, and kickstart -k does.
    expect(launchdStep(100, 100)).toBe("kickstart");
    // KeepAlive relaunched it: kickstart -k would kill it mid-boot.
    expect(launchdStep(200, 100)).toBe("wait");
    expect(launchdStep(undefined, undefined)).toBe("kickstart");
  });
});
