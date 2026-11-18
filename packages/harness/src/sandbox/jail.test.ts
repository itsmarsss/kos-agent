import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { jailedCommand, kosPorts, kosSecretFiles, sandboxProfile } from "./jail.js";

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

  it("denies writing what is read-only, both spellings, after the workspace is allowed", () => {
    const p = sandboxProfile({ workspaceRoot: "/tmp/ws", homes: [], readOnly: ["/tmp/ws/mcp.json"] });
    const allow = p.indexOf('(allow file-write* (subpath "/tmp/ws")');
    const deny = p.indexOf('(deny file-write* (subpath "/tmp/ws/mcp.json") (subpath "/private/tmp/ws/mcp.json"))');
    expect(allow).toBeGreaterThan(-1);
    expect(deny).toBeGreaterThan(allow);
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

  it("keeps the network and the whole workspace writable unless told otherwise, all but KOS's own ports", () => {
    const p = sandboxProfile({ workspaceRoot: "/w", homes: [], kosPorts: [4317, 4318], secretFiles: [] });
    expect(p).not.toContain("network*");
    expect(p).toContain('(deny network-outbound (remote ip "*:4317"))');
    expect(p).toContain('(deny network-outbound (remote ip "*:4318"))');
    expect(p).toContain('(allow file-write* (subpath "/w")');
    expect(kosPorts({ KOS_PORT: "4420" })).toEqual([4420, 4421, 4422, 9225]);
    expect(kosPorts({ KOS_DEVICE_LAN_PORT: "4500", KOS_BROWSER_PORT: "9300" })).toEqual([4317, 4318, 4500, 9300]);
  });

  it("denies reading this boot's write key and KOS's keys, after every allow", () => {
    const p = sandboxProfile({ workspaceRoot: "/w", homes: [], secretFiles: ["/w/write.key", "/Users/me/.kos"] });
    const deny = p.indexOf('(deny file-read* (subpath "/w/write.key")');
    expect(deny).toBeGreaterThan(p.lastIndexOf("(allow file-read* "));
    expect(kosSecretFiles({ KOS_WRITE_KEY_FILE: "/tmp/k" })[0]).toBe("/tmp/k");
  });

  it.runIf(process.platform === "darwin")("stops a jailed program reaching KOS's port on this machine, and lets it reach another", async () => {
    const kos = createServer((_q, r) => r.end("kos"));
    const other = createServer((_q, r) => r.end("other"));
    await Promise.all([kos, other].map((s) => new Promise<void>((done) => s.listen(0, "127.0.0.1", done))));
    const portOf = (s: ReturnType<typeof createServer>): number => (s.address() as { port: number }).port;
    // Run apart from this process, whose servers must go on answering meanwhile.
    const run = async (port: number): Promise<string> => {
      const jailed = jailedCommand(`curl -s -m 3 http://127.0.0.1:${port}/ || echo refused`, { workspaceRoot: tmpdir(), homes: [], kosPorts: [portOf(kos)], secretFiles: [] });
      return (await promisify(execFile)(jailed.file, jailed.args, { encoding: "utf8" })).stdout.trim();
    };
    try {
      expect(await run(portOf(kos))).toBe("refused");
      expect(await run(portOf(other))).toBe("other");
    } finally {
      await Promise.all([kos, other].map((s) => new Promise((done) => s.close(done))));
    }
  });

  it.runIf(process.platform === "darwin")("stops a jailed program reading the write key, and reaching KOS's port by a mapped address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kos-jail-key-"));
    const key = join(dir, "write.key");
    writeFileSync(key, "sekrit\n");
    const kos = createServer((_q, r) => r.end("kos"));
    await new Promise<void>((done) => kos.listen(0, "::", done));
    const port = (kos.address() as { port: number }).port;
    const run = async (command: string): Promise<string> => {
      const jailed = jailedCommand(`${command} 2>/dev/null || echo refused`, { workspaceRoot: dir, homes: [], kosPorts: [port], secretFiles: [key] });
      return (await promisify(execFile)(jailed.file, jailed.args, { encoding: "utf8" })).stdout.trim();
    };
    try {
      expect(await run(`cat ${key}`)).toBe("refused");
      expect(await run(`curl -s -m 3 'http://[::ffff:127.0.0.1]:${port}/'`)).toBe("refused");
      expect(await run(`curl -s -m 3 'http://[::1]:${port}/'`)).toBe("refused");
    } finally {
      await new Promise((done) => kos.close(done));
      rmSync(dir, { recursive: true, force: true });
    }
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
