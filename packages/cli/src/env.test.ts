import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envFilePath, loadEnv } from "./env.js";

describe("loadEnv", () => {
  let dir: string;
  let prevCwd: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kos-env-"));
    prevCwd = process.cwd();
    process.chdir(dir);
    for (const key of ["KOS_TEST_ENV_A", "KOS_TEST_ENV_B"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("loads KEY=value pairs without overwriting the shell's", () => {
    const file = join(dir, "kos.env");
    writeFileSync(file, "# comment\nKOS_TEST_ENV_A=fromfile\nKOS_TEST_ENV_B=keep\n");
    process.env.KOS_TEST_ENV_B = "shell";
    loadEnv(file);
    expect(process.env.KOS_TEST_ENV_A).toBe("fromfile");
    expect(process.env.KOS_TEST_ENV_B).toBe("shell");
  });

  it("strips surrounding quotes", () => {
    const file = join(dir, "kos.env");
    writeFileSync(file, `KOS_TEST_ENV_A="quoted value"\n`);
    loadEnv(file);
    expect(process.env.KOS_TEST_ENV_A).toBe("quoted value");
  });

  it("never reads a .env from the current directory", () => {
    writeFileSync(join(dir, ".env"), "KOS_TEST_ENV_A=from-cwd\n");
    expect(envFilePath({})).toBe(resolve(fileURLToPath(import.meta.url), "../../../..", ".env"));
  });

  it("takes KOS_ENV_FILE over the repository's", () => {
    expect(envFilePath({ KOS_ENV_FILE: "/etc/kos/env" })).toBe("/etc/kos/env");
  });
});
