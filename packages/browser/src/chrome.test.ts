import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { ChromeHost, chromeArgs, findChrome } from "./chrome.js";

/**
 * One Chrome, found where Chromes are, started with a tab per window in
 * mind, adopted when already there, and forgotten when it dies.
 */

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
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
