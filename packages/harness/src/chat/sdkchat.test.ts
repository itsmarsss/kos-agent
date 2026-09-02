import { describe, expect, it } from "vitest";

import { plainName, priorForSdk, sdkName } from "./sdkchat.js";

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

/**
 * The SDK path was stateless: each turn arrived with only the latest message,
 * so the agent had no idea what had just been said to it.
 */
describe("carrying the conversation", () => {
  const said = (role: string, text: string) => ({
    role,
    content: [{ type: "text", text }],
  });

  it("puts what was said before in front of what was just said", () => {
    const out = priorForSdk(
      [said("user", "my cat is called Mote"), said("assistant", "Noted.")],
      "what is my cat called?",
    );
    expect(out).toContain("Owner: my cat is called Mote");
    expect(out).toContain("You: Noted.");
    expect(out).toContain("what is my cat called?");
    // The history is fenced so the model can tell the record from the request.
    expect(out.indexOf("history>>>")).toBeLessThan(
      out.indexOf("what is my cat called?"),
    );
  });

  it("sends the message alone when there is nothing behind it", () => {
    expect(priorForSdk([], "first thing")).toBe("first thing");
  });

  it("ignores blocks that carry no words", () => {
    // Tool calls and results are in the transcript too; they are not speech,
    // and pasting them back as prose would be noise.
    const out = priorForSdk(
      [
        { role: "assistant", content: [{ type: "tool_use", id: "1", name: "x" }] },
        said("user", "hello"),
      ],
      "next",
    );
    expect(out).toContain("Owner: hello");
    expect(out).not.toContain("tool_use");
  });
});
