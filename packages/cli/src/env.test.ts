import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEnv } from "./env.js";

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

  it("loads KEY=value pairs from cwd .env without overwriting", () => {
    writeFileSync(
      join(dir, ".env"),
      "# comment\nKOS_TEST_ENV_A=fromfile\nKOS_TEST_ENV_B=keep\n",
    );
    process.env.KOS_TEST_ENV_B = "shell";
    loadEnv();
    expect(process.env.KOS_TEST_ENV_A).toBe("fromfile");
    expect(process.env.KOS_TEST_ENV_B).toBe("shell");
  });

  it("strips surrounding quotes", () => {
    writeFileSync(join(dir, ".env"), `KOS_TEST_ENV_A="quoted value"\n`);
    loadEnv();
    expect(process.env.KOS_TEST_ENV_A).toBe("quoted value");
  });
});
