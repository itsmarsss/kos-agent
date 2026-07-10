import { describe, expect, it } from "vitest";

import { parseArgs } from "./commands.js";

describe("daemon CLI flags", () => {
  it("parses start with detach-related flags", () => {
    const p = parseArgs([
      "start",
      "--foreground",
      "--port",
      "4500",
      "--workspace",
      "/tmp/w",
    ]);
    expect(p.command).toBe("start");
    expect(p.flags.foreground).toBe(true);
    expect(p.flags.port).toBe("4500");
    expect(p.flags.workspace).toBe("/tmp/w");
  });

  it("defaults to chat", () => {
    expect(parseArgs([]).command).toBe("chat");
  });
});
