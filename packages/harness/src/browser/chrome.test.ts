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
    expect(chromeArgs({ port: 9225, profileDir: "/w", headed: true })[0]).not.toBe("--headless=new");
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
      binary: "/opt/mine/chrome",
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
