import { describe, expect, it } from "vitest";

import { ownerOnlyWords } from "./owneronly.js";

describe("the line under the post-without-asking switch", () => {
  it("names the channels yours alone, or why there are none", () => {
    expect(ownerOnlyWords({ connected: true, channels: [{ name: "kos" }, { name: "school" }] })).toBe("Yours alone right now: #kos, #school.");
    expect(ownerOnlyWords({ connected: true, channels: [], blocked: "The role Mods grants Administrator, so whoever holds it may read every channel: none counts as yours alone." })).toMatch(/^The role Mods grants Administrator/);
    expect(ownerOnlyWords({ connected: true, channels: [] })).toBe("No channel on the server is yours alone right now.");
    expect(ownerOnlyWords({ connected: false, channels: [] })).toMatch(/No Discord server is connected/);
  });
});
