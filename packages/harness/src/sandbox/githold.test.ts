import { describe, expect, it } from "vitest";

import { EMPTY_TREE, gitControlPatterns, gitControlRefusal, gitHoldEnv, honoursAttrSource } from "./githold.js";
import { sandboxProfile } from "./jail.js";

describe("gitHoldEnv", () => {
  const pinned = (env: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) out[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
    return out;
  };

  it("pins every setting that names a program, and the pagers and editors", () => {
    const env = gitHoldEnv({ PATH: "/usr/bin", HOME: "/ws" }, true);
    expect(pinned(env)).toMatchObject({
      "core.hooksPath": "/dev/null",
      "core.fsmonitor": "false",
      "core.pager": "cat",
      "commit.gpgSign": "false",
      "tag.gpgSign": "false",
      "safe.bareRepository": "explicit",
    });
    expect(env).toMatchObject({ GIT_ATTR_SOURCE: EMPTY_TREE, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_PAGER: "cat", PAGER: "cat", PATH: "/usr/bin", HOME: "/ws" });
  });

  it("goes after the command's own entries, so it is read last and wins", () => {
    const env = gitHoldEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "./x" }, true);
    expect(env.GIT_CONFIG_KEY_0).toBe("core.fsmonitor");
    expect(env.GIT_CONFIG_VALUE_0).toBe("./x");
    const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    expect(keys.lastIndexOf("core.fsmonitor")).toBeGreaterThan(0);
    expect(pinned(env)["core.fsmonitor"]).toBe("false");
  });

  it("leaves GIT_ATTR_SOURCE off a git older than 2.40", () => {
    expect(gitHoldEnv({}, false).GIT_ATTR_SOURCE).toBeUndefined();
    expect(honoursAttrSource("git version 2.47.1")).toBe(true);
    expect(honoursAttrSource("git version 2.40.0 (Apple Git-145)")).toBe(true);
    expect(honoursAttrSource("git version 2.39.5 (Apple Git-154)")).toBe(false);
    expect(honoursAttrSource("git version 3.0.0")).toBe(true);
    expect(honoursAttrSource("")).toBe(false);
  });
});

describe("git's control, kept from the agent", () => {
  it("refuses a .git anywhere, and the global config under the workspace", () => {
    for (const rel of ["projects/x/.git/config", "projects/x/.git/hooks/post-checkout", ".git/config", "projects/y/.git", "a/.git/info/attributes", ".gitconfig", ".config/git/config", ".config/git"]) {
      expect(gitControlRefusal(rel), rel).toContain("git's own control");
    }
    for (const rel of ["projects/x/.gitignore", "projects/x/.gitattributes", "notes/git.md", ".config/other/x", "projects/x.git/readme", "projects/.github/workflows/ci.yml"]) {
      expect(gitControlRefusal(rel), rel).toBeUndefined();
    }
  });

  it("puts the patterns into the sandbox as writes denied", () => {
    const profile = sandboxProfile({ workspaceRoot: "/ws", readOnlyPatterns: gitControlPatterns("/private/var/ws") });
    expect(profile).toContain('(deny file-write* (regex #"/\\.git/(config|info/attributes)$")');
    expect(profile).toContain('(regex #"^(/private)?/var/ws/\\.gitconfig$")');
    const [config, hooks, global, xdg] = gitControlPatterns("/var/ws").map((p) => new RegExp(p));
    expect(config!.test("/private/var/ws/p/.git/config")).toBe(true);
    expect(config!.test("/private/var/ws/p/.git/config.lock")).toBe(false);
    expect(hooks!.test("/var/ws/p/.git/hooks/pre-commit")).toBe(true);
    expect(hooks!.test("/var/ws/p/.git/hooks")).toBe(true);
    expect(global!.test("/private/var/ws/.gitconfig")).toBe(true);
    expect(global!.test("/var/ws/p/.gitconfig")).toBe(false);
    expect(xdg!.test("/var/ws/.config/git/config")).toBe(true);
  });
});
