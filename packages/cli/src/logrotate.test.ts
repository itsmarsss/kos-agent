import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rotateOwnLog } from "./logrotate.js";

describe("rotateOwnLog", () => {
  let dir: string;
  let log: string;
  let fd: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kos-log-"));
    log = join(dir, "daemon.log");
    fd = openSync(log, "a");
  });
  afterEach(() => {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a log under the limit alone", () => {
    writeSync(fd, "small\n");
    expect(rotateOwnLog(log, { fd, maxBytes: 100 })).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("small\n");
  });

  it("moves a full log to .1, keeps three, and goes on writing at the start", () => {
    writeFileSync(`${log}.1`, "one");
    writeFileSync(`${log}.2`, "two");
    writeFileSync(`${log}.3`, "three");
    writeSync(fd, "x".repeat(200));
    expect(rotateOwnLog(log, { fd, maxBytes: 100, keep: 3 })).toBe(true);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(200));
    expect(readFileSync(`${log}.2`, "utf8")).toBe("one");
    expect(readFileSync(`${log}.3`, "utf8")).toBe("two");
    expect(existsSync(`${log}.4`)).toBe(false);
    writeSync(fd, "after\n");
    expect(readFileSync(log, "utf8")).toBe("after\n");
    expect(statSync(log).size).toBe(6);
  });

  it("never touches a file the process is not writing to", () => {
    const other = join(dir, "other.log");
    writeFileSync(other, "y".repeat(200));
    expect(rotateOwnLog(other, { fd, maxBytes: 100 })).toBe(false);
    expect(existsSync(`${other}.1`)).toBe(false);
  });
});
