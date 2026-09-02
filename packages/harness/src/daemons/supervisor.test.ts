import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JailError } from "../jail/resolvePath.js";
import { DaemonSupervisor } from "./supervisor.js";
import type { Daemon } from "./types.js";

/**
 * The supervisor runs real child processes, because what these are checking is
 * exactly the part a fake would get wrong: what a spawned program can see, and
 * what happens when it dies.
 */

function daemonFor(overrides: Partial<Daemon> = {}): Daemon {
  return {
    id: 1,
    project: "app",
    name: "api",
    runtime: "node",
    entry: "projects/app/server.js",
    args: [],
    port: null,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Wait for a condition the child process reaches on its own schedule. */
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}

describe("DaemonSupervisor", () => {
  let root: string;
  let supervisor: DaemonSupervisor;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-daemon-"));
    mkdirSync(join(root, "projects", "app"), { recursive: true });
    supervisor = new DaemonSupervisor({ workspaceRoot: root });
  });

  afterEach(async () => {
    await supervisor.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a program and captures what it prints", async () => {
    writeFileSync(
      join(root, "projects", "app", "server.js"),
      "console.log('up'); setInterval(() => {}, 1000);",
    );
    supervisor.start(daemonFor());
    await until(() => supervisor.logs(1).includes("up"));
    expect(supervisor.statusOf(1).state).toBe("running");
    expect(supervisor.statusOf(1).pid).toBeGreaterThan(0);
  });

  it("hands over the port it was given and nothing else", async () => {
    // The whole environment, so what is absent is as much the assertion as
    // what is present: a daemon must not be able to read the owner's keys.
    writeFileSync(
      join(root, "projects", "app", "server.js"),
      "console.log(JSON.stringify(process.env)); setInterval(() => {}, 1000);",
    );
    process.env.KOS_TEST_SECRET = "do-not-leak";
    try {
      supervisor.start(daemonFor({ port: 4455 }));
      await until(() => supervisor.logs(1).length > 0);
      const env = JSON.parse(supervisor.logs(1).join("")) as Record<string, string>;
      expect(env.PORT).toBe("4455");
      expect(env.HOST).toBe("127.0.0.1");
      expect(env.KOS_DAEMON).toBe("1");
      expect(env.KOS_TEST_SECRET).toBeUndefined();
      // HOME points inside the workspace, so anything that scatters caches
      // does it somewhere the agent is allowed to be.
      expect(env.HOME).toContain("projects");
    } finally {
      delete process.env.KOS_TEST_SECRET;
    }
  });

  it("refuses to run a program outside the workspace", () => {
    // The jail is the whole perimeter here, so it is checked before anything
    // is spawned rather than after.
    expect(() => supervisor.start(daemonFor({ entry: "../escape.js" }))).toThrow(
      JailError,
    );
  });

  it("refuses to follow a symlink out of the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "kos-outside-"));
    writeFileSync(join(outside, "evil.js"), "console.log('out')");
    symlinkSync(join(outside, "evil.js"), join(root, "projects", "app", "link.js"));
    try {
      expect(() =>
        supervisor.start(daemonFor({ entry: "projects/app/link.js" })),
      ).toThrow(JailError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("restarts a program that dies on its own", async () => {
    writeFileSync(
      join(root, "projects", "app", "server.js"),
      "console.log('run'); process.exit(1);",
    );
    supervisor.start(daemonFor());
    // Two runs means it came back, which is the whole job.
    await until(() => supervisor.logs(1).filter((l) => l === "run").length >= 2, 8000);
    expect(supervisor.statusOf(1).restarts).toBeGreaterThan(0);
  });

  it("leaves a program alone once it is deliberately stopped", async () => {
    writeFileSync(
      join(root, "projects", "app", "server.js"),
      "console.log('up'); setInterval(() => {}, 1000);",
    );
    supervisor.start(daemonFor());
    await until(() => supervisor.statusOf(1).state === "running");
    await supervisor.stop(1);
    expect(supervisor.statusOf(1).state).toBe("stopped");
    expect(supervisor.isRunning(1)).toBe(false);
    // A stop must not read as a crash, or the supervisor would fight the owner.
    await new Promise((r) => setTimeout(r, 300));
    expect(supervisor.statusOf(1).state).toBe("stopped");
  });

  it("stops everything when the host goes down", async () => {
    writeFileSync(
      join(root, "projects", "app", "server.js"),
      "setInterval(() => {}, 1000);",
    );
    supervisor.start(daemonFor({ id: 1 }));
    supervisor.start(daemonFor({ id: 2, name: "worker" }));
    await until(() => supervisor.isRunning(1) && supervisor.isRunning(2));
    await supervisor.stopAll();
    expect(supervisor.isRunning(1)).toBe(false);
    expect(supervisor.isRunning(2)).toBe(false);
  });
});
