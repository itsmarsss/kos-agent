import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ChromeHost, chromeArgs, findChrome } from "./chrome.js";

/**
 * One Chrome, found where Chromes are, started with a tab per window in
 * mind, adopted when already there, and forgotten when it dies.
 */

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0);
    return true;
  }
}

describe("finding and starting Chrome", () => {
  it("prefers the named binary, else the first known one that exists", () => {
    const exists = (p: string): boolean => p === "/Applications/Chromium.app/Contents/MacOS/Chromium" || p === "/opt/mine/chrome";
    expect(findChrome("/opt/mine/chrome", exists)).toBe("/opt/mine/chrome");
    expect(findChrome("/opt/nope", exists)).toBe("/Applications/Chromium.app/Contents/MacOS/Chromium");
    expect(findChrome(undefined, () => false)).toBeUndefined();
  });

  it("runs headless on the named port and profile unless told to show the window", () => {
    const args = chromeArgs({ port: 9225, profileDir: "/w/.kos/browser-profile" });
    expect(args[0]).toBe("--headless=new");
    expect(args).toContain("--remote-debugging-port=9225");
    expect(args).toContain("--user-data-dir=/w/.kos/browser-profile");
    expect(args).toContain("--window-size=1600,1000");
    expect(args).not.toContain("--enable-unsafe-extension-debugging");
    expect(chromeArgs({ port: 9225, profileDir: "/w", headed: true })[0]).not.toBe("--headless=new");
  });

  it("finds none when told there is none, as a machine without Chrome would", () => {
    const before = process.env.KOS_CHROME;
    process.env.KOS_CHROME = "none";
    try {
      expect(findChrome("/x/chrome", () => true)).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.KOS_CHROME;
      else process.env.KOS_CHROME = before;
    }
    expect(findChrome("/x/chrome", () => true)).toBe("/x/chrome");
  });

  it("cuts a sealed Chrome off at its resolver and proxy, but its own loopback ports, and leaves the web browser's network alone", () => {
    const sealed = chromeArgs({ port: 9225, profileDir: "/w", sealed: { loopback: [4100, 4101] } });
    expect(sealed).toContain("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
    expect(sealed).toContain("--proxy-server=127.0.0.1:9");
    expect(sealed).toContain("--proxy-bypass-list=<-loopback>;127.0.0.1:4100;127.0.0.1:4101");
    const web = chromeArgs({ port: 9225, profileDir: "/w" });
    expect(web.some((a) => /host-resolver|proxy|webrtc/.test(a))).toBe(false);
  });

  it("allows extensions to be loaded over the protocol when it has some, and reads the launch afresh each start", async () => {
    const withExtensions = chromeArgs({ port: 9225, profileDir: "/w", extensions: ["/x/one", "", "/x/two"] });
    expect(withExtensions).toContain("--enable-unsafe-extension-debugging");
    // Branded Chrome ignores the flag, so it is not relied on.
    expect(withExtensions.some((a) => a.startsWith("--load-extension"))).toBe(false);
    let headed = false;
    // The port answers while a spawned Chrome lives, and not after it is stopped.
    let alive = false;
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      child.on("exit", () => {
        alive = false;
      });
      alive = true;
      return child;
    });
    const host = new ChromeHost({
      port: 9225,
      profileDir: "/tmp/kos-chrome-test",
      launch: () => ({ binary: "/opt/mine/chrome", headed, extensions: ["/x/one"] }),
      exists: (p) => p === "/opt/mine/chrome",
      spawn: spawn as never,
      fetchJson: async () => {
        if (!alive) throw new Error("refused");
        return { webSocketDebuggerUrl: "ws://127.0.0.1:9225/devtools/browser/new" };
      },
    });
    expect(host.launch).toEqual({ binary: "/opt/mine/chrome", headed: false, extensions: ["/x/one"], found: "/opt/mine/chrome" });
    await host.ensure();
    const first = (spawn.mock.calls[0] as unknown[])[1] as string[];
    expect(first[0]).toBe("--headless=new");
    expect(first).toContain("--enable-unsafe-extension-debugging");
    headed = true;
    host.stop();
    await host.ensure();
    const second = (spawn.mock.calls[1] as unknown[])[1] as string[];
    expect(second[0]).not.toBe("--headless=new");
  });

  it("waits for a Chrome told to close to stop answering", async () => {
    let answers = 2;
    const host = new ChromeHost({
      port: 9225,
      profileDir: "/tmp/x",
      fetchJson: async () => {
        if (answers-- > 0) return { webSocketDebuggerUrl: "ws://old" };
        throw new Error("refused");
      },
    });
    await host.waitGone();
    expect(answers).toBeLessThan(0);
  });

  it("waits for the Chrome it started to exit, so what it writes as it closes is written", async () => {
    let child: FakeChild | undefined;
    let up = false;
    const host = new ChromeHost({
      port: 9225,
      profileDir: "/tmp/kos-chrome-test",
      exists: () => true,
      spawn: (() => {
        child = new FakeChild();
        up = true;
        return child;
      }) as never,
      fetchJson: async () => {
        if (!up) throw new Error("refused");
        return { webSocketDebuggerUrl: "ws://new" };
      },
    });
    await host.ensure();
    let done = false;
    const waiting = host.waitExit(5_000).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    child!.exitCode = 0;
    child!.emit("exit", 0);
    await waiting;
    expect(done).toBe(true);
  });

  it("adopts a Chrome already answering on the port", async () => {
    const spawn = vi.fn();
    const host = new ChromeHost({
      port: 9225,
      profileDir: "/tmp/kos-chrome-test",
      spawn: spawn as never,
      fetchJson: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9225/devtools/browser/abc" }),
    });
    expect(host.state).toBe("stopped");
    expect(await host.ensure()).toBe("ws://127.0.0.1:9225/devtools/browser/abc");
    expect(spawn).not.toHaveBeenCalled();
    expect(host.state).toBe("running");
  });

  it("starts one when nothing answers, waits for the port, and notices it dying", async () => {
    let answers = 0;
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const host = new ChromeHost({
      port: 9225,
      profileDir: "/tmp/kos-chrome-test",
      launch: () => ({ binary: "/opt/mine/chrome" }),
      exists: (p) => p === "/opt/mine/chrome",
      spawn: spawn as never,
      fetchJson: async () => {
        answers++;
        if (answers < 3) throw new Error("refused");
        return { webSocketDebuggerUrl: "ws://127.0.0.1:9225/devtools/browser/new" };
      },
    });
    const gone = vi.fn();
    host.onExit(gone);
    const url = await host.ensure();
    expect(url).toBe("ws://127.0.0.1:9225/devtools/browser/new");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((spawn.mock.calls[0] as unknown[])[0]).toBe("/opt/mine/chrome");
    expect(host.state).toBe("running");
    child.emit("exit", 1);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(host.state).toBe("stopped");
  });

  it("says plainly when there is no Chrome to run", async () => {
    const host = new ChromeHost({ port: 9225, profileDir: "/tmp/x", exists: () => false, fetchJson: async () => { throw new Error("refused"); } });
    await expect(host.ensure()).rejects.toThrow(/no Chrome found/);
  });
});

describe("stopping Chrome", () => {
  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills the whole process group, a helper that ignores SIGTERM included, and resolves once it has exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrome-stop-"));
    try {
      const helperPid = join(dir, "helper.pid");
      let spawned = false;
      // Stands in for Chrome: a browser and a helper of its own, both deaf to SIGTERM.
      const script = `trap '' TERM; sleep 60 & echo $! > '${helperPid}'; wait`;
      const host = new ChromeHost({
        port: 9225,
        profileDir: join(dir, "profile"),
        exists: () => true,
        spawn: ((_binary: string, _args: string[], options: object) => {
          spawned = true;
          return nodeSpawn("/bin/sh", ["-c", script], options);
        }) as never,
        fetchJson: async () => {
          if (!spawned) throw new Error("refused");
          return { webSocketDebuggerUrl: "ws://new" };
        },
      });
      await host.ensure();
      await vi.waitFor(() => expect(readFileSync(helperPid, "utf8").trim()).not.toBe(""));
      const helper = Number(readFileSync(helperPid, "utf8"));
      const started = Date.now();
      await host.stop(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      await vi.waitFor(() => expect(running(helper)).toBe(false));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the browser alone first, so its helpers keep running while it closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrome-stop-"));
    try {
      const heard = join(dir, "heard");
      const helperPid = join(dir, "helper.pid");
      const deaf = (who: string): string => `process.on("SIGTERM", () => require("fs").appendFileSync(${JSON.stringify(heard)}, "${who}\\n")); setInterval(() => {}, 1000);`;
      // A browser and a helper in its group, each noting a SIGTERM and staying. The helper says it is listening.
      const helperCode = `${deaf("helper")} require("fs").writeFileSync(${JSON.stringify(helperPid)}, String(process.pid));`;
      const browser = `${deaf("browser")} require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(helperCode)}], { stdio: "ignore" });`;
      let spawned = false;
      const host = new ChromeHost({
        port: 9225,
        profileDir: join(dir, "profile"),
        exists: () => true,
        spawn: ((_binary: string, _args: string[], options: object) => {
          spawned = true;
          return nodeSpawn(process.execPath, ["-e", browser], options);
        }) as never,
        fetchJson: async () => {
          if (!spawned) throw new Error("refused");
          return { webSocketDebuggerUrl: "ws://new" };
        },
      });
      await host.ensure();
      await vi.waitFor(() => expect(readFileSync(helperPid, "utf8")).not.toBe(""), { timeout: 5000 });
      const helper = Number(readFileSync(helperPid, "utf8"));
      await host.stop(500);
      expect(readFileSync(heard, "utf8")).toBe("browser\n");
      await vi.waitFor(() => expect(running(helper)).toBe(false));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves at once when there is nothing of its own to stop", async () => {
    const host = new ChromeHost({ port: 9225, profileDir: "/tmp/x" });
    await expect(host.stop()).resolves.toBeUndefined();
  });
});
