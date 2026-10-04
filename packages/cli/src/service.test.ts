import { describe, expect, it } from "vitest";

import { launchdPlist, logPath, parsePrint, plistPath, workspaceOfPlist } from "./service.js";

const spec = {
  label: "dev.kos.host",
  node: "/opt/homebrew/bin/node",
  main: "/Users/me/kos-agent/packages/cli/dist/main.js",
  cwd: "/Users/me/kos-agent",
  workspace: "/Users/me/kos-workspace",
  host: "127.0.0.1",
  port: 4317,
  discord: true,
};

describe("the launchd agent", () => {
  it("runs the host in the foreground with its workspace and port spelled out", () => {
    const plist = launchdPlist(spec);
    const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(args.slice(0, 9)).toEqual([
      "dev.kos.host",
      "/opt/homebrew/bin/node",
      "/Users/me/kos-agent/packages/cli/dist/main.js",
      "start",
      "--foreground",
      "--workspace",
      "/Users/me/kos-workspace",
      "--host",
      "127.0.0.1",
    ]);
    expect(plist).toContain("<string>4317</string>");
    expect(plist).not.toContain("--no-discord");
    expect(launchdPlist({ ...spec, discord: false })).toContain("<string>--no-discord</string>");
  });

  it("comes back after a crash and stays down after kos stop", () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain("<key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>10</integer>");
  });

  it("logs where kos start logs, and runs from the repo so .env is found", () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain(`<key>StandardOutPath</key><string>${logPath(spec.workspace)}</string>`);
    expect(plist).toContain("<key>WorkingDirectory</key><string>/Users/me/kos-agent</string>");
    // launchd starts with almost no PATH; node's own directory leads it.
    expect(plist).toMatch(/<key>PATH<\/key><string>\/opt\/homebrew\/bin:/);
  });

  it("carries extra environment and escapes what XML would misread", () => {
    const plist = launchdPlist({
      ...spec,
      workspace: "/Users/me/a&b <ws>",
      env: { KOS_OWNER_IMESSAGE: "" },
    });
    expect(plist).toContain("<string>/Users/me/a&amp;b &lt;ws&gt;</string>");
    expect(plist).toContain("<key>KOS_OWNER_IMESSAGE</key><string></string>");
  });

  it("lives under the user's LaunchAgents", () => {
    expect(plistPath("dev.kos.host")).toMatch(/\/Library\/LaunchAgents\/dev\.kos\.host\.plist$/);
  });

  it("reads the workspace back out of its own plist", () => {
    expect(workspaceOfPlist(launchdPlist(spec))).toBe("/Users/me/kos-workspace");
    expect(workspaceOfPlist(launchdPlist({ ...spec, workspace: "/Users/me/a&b <ws>" }))).toBe("/Users/me/a&b <ws>");
    expect(workspaceOfPlist("<plist/>")).toBeUndefined();
  });

  it("reads the pid out of launchctl print", () => {
    expect(parsePrint("dev.kos.host = {\n\tactive count = 1\n\tpath = /x\n\tstate = running\n\n\tpid = 4242\n")).toEqual({ pid: 4242 });
    expect(parsePrint("state = not running\n")).toEqual({});
  });
});
