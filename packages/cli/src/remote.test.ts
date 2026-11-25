import type { KosClient } from "@kos/client";
import { describe, expect, it } from "vitest";

import { runRemoteCommand } from "./remote.js";

describe("a remote approve and deny", () => {
  it("names the command line as where each was decided", async () => {
    const calls: unknown[][] = [];
    const client = {
      approve: async (...args: unknown[]) => (calls.push(["approve", ...args]), { ok: true, message: "approved" }),
      deny: async (...args: unknown[]) => (calls.push(["deny", ...args]), { ok: true, message: "denied" }),
    } as unknown as KosClient;
    expect(await runRemoteCommand(client, "approve", ["7"])).toBe("approved");
    expect(await runRemoteCommand(client, "deny", ["8"])).toBe("denied");
    expect(calls).toEqual([
      ["approve", 7, { via: "cli" }],
      ["deny", 8, { via: "cli" }],
    ]);
  });
});
