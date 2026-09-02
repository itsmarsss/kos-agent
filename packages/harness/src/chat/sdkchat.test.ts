import { describe, expect, it } from "vitest";

import { plainName, sdkName } from "./sdkchat.js";

/**
 * The names are the containment boundary.
 *
 * A chat turn on the SDK may use KOS's tools and nothing else: Claude Code's
 * own Read, Write and Bash know nothing about the workspace jail or the risk
 * tiers. The allow list is built from the registry by name, so the mapping
 * between a KOS tool and the name the SDK knows it by has to round-trip
 * exactly. A name that fails to map is a tool that silently does not exist,
 * and a built-in that slips past the list is the jail gone.
 */
describe("tool names across the boundary", () => {
  it("round-trips a dotted tool name", () => {
    for (const name of ["files.read", "systems.project_create", "notify"]) {
      expect(plainName(sdkName(name))).toBe(name.replace(/\./g, "_"));
    }
  });

  it("prefixes with the server, so nothing collides with a built-in", () => {
    // Claude Code has its own Read. KOS's files.read must not be able to be
    // confused with it, in either direction.
    expect(sdkName("files.read")).toBe("mcp__kos__files_read");
    expect(sdkName("Read")).not.toBe("Read");
  });

  it("leaves a name it did not write alone", () => {
    // A built-in arriving here is not ours to rename; it should stay
    // recognisable so it can be refused rather than quietly rewritten.
    expect(plainName("Bash")).toBe("Bash");
    expect(plainName("mcp__other__thing")).toBe("mcp__other__thing");
  });
});
