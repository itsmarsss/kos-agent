import { describe, expect, it } from "vitest";

import { EMPTY_TREE, GIT_INFO_ATTRIBUTES, gitControlRefusal, gitHoldable, gitHoldEnv } from "./githold.js";
import { sandboxProfile } from "./jail.js";

describe("gitHoldEnv", () => {
  const pinned = (env: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) out[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
    return out;
  };

  it("pins every setting that names a program, and the pagers and editors", () => {
    const env = gitHoldEnv({ PATH: "/usr/bin", HOME: "/ws" }, { attrSource: true });
    expect(pinned(env)).toMatchObject({
      "core.fsmonitor": "false",
      "core.pager": "cat",
      "commit.gpgSign": "false",
      "tag.gpgSign": "false",
      "safe.bareRepository": "explicit",
    });
    expect(env).toMatchObject({ GIT_ATTR_SOURCE: EMPTY_TREE, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_PAGER: "cat", PAGER: "cat", PATH: "/usr/bin", HOME: "/ws" });
  });

  it("keeps an approved run's hooks and transport, and takes them from a read-only run", () => {
    const approved = gitHoldEnv({}, { attrSource: true });
    expect(pinned(approved)["core.hooksPath"]).toBeUndefined();
    expect(approved.GIT_ALLOW_PROTOCOL).toBeUndefined();
    const held = gitHoldEnv({}, { attrSource: true, readOnly: true });
    expect(pinned(held)["core.hooksPath"]).toBe("/dev/null");
    expect(held.GIT_ALLOW_PROTOCOL).toBe("");
    expect(held.GIT_NO_LAZY_FETCH).toBe("1");
  });

  it("goes after the command's own entries, so it is read last and wins", () => {
    const env = gitHoldEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "./x" }, { attrSource: true });
    expect(env.GIT_CONFIG_KEY_0).toBe("core.fsmonitor");
    expect(env.GIT_CONFIG_VALUE_0).toBe("./x");
    expect(pinned(env)["core.fsmonitor"]).toBe("false");
  });

  it("holds only a git of 2.40 or later, and leaves GIT_ATTR_SOURCE off otherwise", () => {
    expect(gitHoldEnv({}, { attrSource: false }).GIT_ATTR_SOURCE).toBeUndefined();
    expect(gitHoldable("git version 2.47.1")).toBe(true);
    expect(gitHoldable("git version 2.40.0 (Apple Git-145)")).toBe(true);
    expect(gitHoldable("git version 2.39.5 (Apple Git-154)")).toBe(false);
    expect(gitHoldable("git version 2.31.0")).toBe(false);
    expect(gitHoldable("git version 3.0.0")).toBe(true);
    expect(gitHoldable("")).toBe(false);
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

  it("puts info/attributes into the sandbox as unreadable", () => {
    const profile = sandboxProfile({ workspaceRoot: "/ws", unreadable: [GIT_INFO_ATTRIBUTES] });
    expect(profile).toContain('(deny file-read* (regex #"/\\.git/info/attributes$"))');
    expect(new RegExp(GIT_INFO_ATTRIBUTES).test("/ws/p/.git/info/attributes")).toBe(true);
  });
});
