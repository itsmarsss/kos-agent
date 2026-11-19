import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { runSkillLive } from "../skills/run.js";
import { runSandbox } from "./runner.js";

/**
 * What a spawned skill can see of the host.
 *
 * The secrets registry says values live in the process environment so that the
 * jail keeps the agent away from them. That reasoning only holds while nothing
 * hands the environment to agent-written code. A child process is the one
 * place that can, so it is the one place worth a test.
 */
describe("what a spawned skill inherits", () => {
  let root: string;
  let ws: Workspace;

  /** In a skill's own folder, which is where a skill runs from. */
  const ENTRY = "skills/r/reporter.js";
  /** The platform's sandbox on macOS; elsewhere the test stands in for the container, which is the jail there, bubblewrap or not. */
  const jail = process.platform === "darwin" ? { contained: false } : { contained: true, bubblewrap: false as const };

  /** A skill that reports the environment it was handed. */
  const REPORTER = `
    const keys = Object.keys(process.env).sort();
    console.log(JSON.stringify({ keys, openai: process.env.OPENAI_API_KEY ?? null }));
  `;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-env-"));
    ws = Workspace.open(root);
    mkdirSync(join(ws.root, "skills", "r"), { recursive: true });
    writeFileSync(join(ws.root, ENTRY), REPORTER);
    process.env.OPENAI_API_KEY = "sk-test-must-not-leak";
    process.env.KOS_SECRET_DISCORD = "discord-must-not-leak";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-must-not-leak";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOS_SECRET_DISCORD;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const report = (stdout: string): { keys: string[]; openai: string | null } =>
    JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      keys: string[];
      openai: string | null;
    };

  it("does not hand the owner's api keys to a sandboxed skill", async () => {
    const result = await runSandbox({ workspaceRoot: ws.root, entry: ENTRY, jail });
    const seen = report(result.stdout);
    expect(seen.openai).toBeNull();
    expect(seen.keys).not.toContain("OPENAI_API_KEY");
    expect(seen.keys).not.toContain("KOS_SECRET_DISCORD");
    expect(seen.keys).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("does not hand them to a promoted skill running live either", async () => {
    const result = await runSkillLive({ workspaceRoot: ws.root, entry: ENTRY, jail });
    const seen = report(result.stdout);
    expect(seen.openai).toBeNull();
    expect(seen.keys).not.toContain("KOS_SECRET_DISCORD");
    expect(seen.keys).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("still passes the variables a skill needs to do its job", async () => {
    const result = await runSandbox({ workspaceRoot: ws.root, entry: ENTRY, jail });
    const seen = report(result.stdout);
    expect(seen.keys).toContain("KOS_DB");
    expect(seen.keys).toContain("KOS_SANDBOX");
    expect(seen.keys).toContain("KOS_DRY_RUN");
    expect(seen.keys).toContain("PATH");
  });
});

describe("where user-installed tools are found", () => {
  it("keeps only absolute PATH entries outside the child's home", async () => {
    const { childEnv } = await import("./env.js");
    const env = childEnv({ home: "/ws" }, {}, { PATH: "/usr/bin:.:bin:/ws/bin:/ws:/wsx/bin:/bin" }, []);
    expect(env.PATH).toBe("/usr/bin:/wsx/bin:/bin");
  });

  it("puts the user's bin directories on the end of PATH, once each", async () => {
    const { childEnv, withBins } = await import("./env.js");
    expect(withBins("/usr/bin:/bin", ["/home/me/.local/bin", "/usr/bin"])).toBe("/usr/bin:/bin:/home/me/.local/bin");
    const env = childEnv({ home: "/ws" }, {}, { PATH: "/usr/bin" }, ["/home/me/.local/bin"]);
    expect(env.PATH).toBe("/usr/bin:/home/me/.local/bin");
    // No PATH at all still gets a usable one, plus the user's.
    expect(childEnv({ home: "/ws" }, {}, {}, ["/x/bin"]).PATH).toMatch(/\/usr\/bin.*\/x\/bin$/);
  });
});
