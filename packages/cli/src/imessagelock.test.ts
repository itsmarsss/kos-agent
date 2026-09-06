import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claimHandle } from "./imessagelock.js";

const HANDLE = "+15550001111-test";
const path = join(homedir(), ".kos", "locks", "imessage-15550001111-test.lock");

describe("one process per thread", () => {
  afterEach(() => {
    if (existsSync(path)) writeFileSync(path, "", "utf8");
  });

  it("grants the claim and records who holds it", () => {
    const got = claimHandle(HANDLE);
    expect(got.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    if (got.ok) got.claim.release();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a second live holder", () => {
    /*
     * Two hosts watching one thread read each other's replies as the owner
     * speaking and answer forever, two real messages a lap. Seen for real
     * when a scratch host was left running as the live one came up.
     */
    mkdirSync(join(homedir(), ".kos", "locks"), { recursive: true });
    // A pid that certainly exists and is not us: our own parent, or pid 1.
    writeFileSync(path, String(process.ppid || 1), "utf8");

    const got = claimHandle(HANDLE);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.heldBy).toBe(process.ppid || 1);
  });

  it("takes over a lock left by a process that has died", () => {
    // Otherwise a host that was killed locks the owner out of their own
    // surface until they go and find the file.
    mkdirSync(join(homedir(), ".kos", "locks"), { recursive: true });
    // Very unlikely to be live, and harmless to signal-0 if it were not.
    writeFileSync(path, "999999", "utf8");

    const got = claimHandle(HANDLE);
    expect(got.ok).toBe(true);
    if (got.ok) got.claim.release();
  });

  it("does not delete a lock another process has taken over", () => {
    const got = claimHandle(HANDLE);
    expect(got.ok).toBe(true);
    writeFileSync(path, String(process.ppid || 1), "utf8");
    if (got.ok) got.claim.release();
    // Still theirs.
    expect(readFileSync(path, "utf8")).toBe(String(process.ppid || 1));
  });
});
