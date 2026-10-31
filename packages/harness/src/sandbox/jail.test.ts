import { describe, expect, it } from "vitest";

import { jailedCommand, sandboxProfile } from "./jail.js";

describe("the shell jail", () => {
  it("denies the owner's home for reading and carves the workspace back out", () => {
    const p = sandboxProfile({ workspaceRoot: "/Users/me/kos-workspace", homes: ["/Users/me"] });
    const deny = p.indexOf('(deny file-read* (subpath "/Users/me"))');
    const allow = p.indexOf('(allow file-read* (subpath "/Users/me/kos-workspace")');
    expect(deny).toBeGreaterThan(-1);
    // Later wins in a sandbox profile, so the workspace allow must follow the home deny.
    expect(allow).toBeGreaterThan(deny);
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(allow file-write* (subpath "/Users/me/kos-workspace")');
  });

  it("spells a /tmp or /var workspace both ways, since macOS links them into /private", () => {
    const p = sandboxProfile({ workspaceRoot: "/tmp/ws", homes: [] });
    expect(p).toContain('(subpath "/tmp/ws") (subpath "/private/tmp/ws")');
  });

  it("escapes a quote in a path rather than letting it end the rule", () => {
    const p = sandboxProfile({ workspaceRoot: '/Users/me/a"b', homes: [] });
    expect(p).toContain('(subpath "/Users/me/a\\"b")');
  });

  it("narrows writes to the folders named, hides KOS's own files, and can cut the network", () => {
    const p = sandboxProfile({
      workspaceRoot: "/w",
      homes: [],
      writes: ["/w/scratch/run"],
      hidden: ["/w/.kos", "/w/kos.sqlite"],
      reads: ["/Users/me/Library/Python/3.9"],
      network: false,
    });
    expect(p).toContain("(deny network*)");
    expect(p).toContain('(allow file-write* (subpath "/w/scratch/run") (subpath "/private/w/scratch/run") (literal "/dev/null")');
    expect(p).not.toMatch(/allow file-write\* \(subpath "\/w"\)/);
    expect(p).toContain('(subpath "/Users/me/Library/Python/3.9")');
    const hidden = p.indexOf('(deny file-read* (subpath "/w/.kos")');
    expect(hidden).toBeGreaterThan(p.indexOf('(allow file-read* (subpath "/w")'));
    // Its own folder is readable again after the hiding.
    expect(p.lastIndexOf('(allow file-read* (subpath "/w/scratch/run")')).toBeGreaterThan(hidden);
  });

  it("keeps the network and the whole workspace writable unless told otherwise", () => {
    const p = sandboxProfile({ workspaceRoot: "/w", homes: [] });
    expect(p).not.toContain("network");
    expect(p).toContain('(allow file-write* (subpath "/w")');
  });

  it("uses the sandbox on macOS, the container when in one, and refuses elsewhere", () => {
    const mac = jailedCommand("ls", { workspaceRoot: "/w", homes: [], platform: "darwin", contained: false });
    expect(mac.file).toBe("/usr/bin/sandbox-exec");
    expect(mac.args.slice(-3)).toEqual(["/bin/sh", "-c", "ls"]);
    const inside = jailedCommand("ls", { workspaceRoot: "/w", platform: "linux", contained: true });
    expect(inside).toEqual({ file: "/bin/sh", args: ["-c", "ls"] });
    expect(() => jailedCommand("ls", { workspaceRoot: "/w", platform: "linux", contained: false })).toThrow(/jail/);
  });
});
