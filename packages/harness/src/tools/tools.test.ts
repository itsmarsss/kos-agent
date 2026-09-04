import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { describeTools } from "./tools.js";

function registryWith(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register(
      {
        name,
        description: `does ${name}\nsecond line that should not appear`,
        inputSchema: { type: "object", properties: {} },
      },
      () => "ok",
      { floor: "safe" },
    );
  }
  return registry;
}

describe("describeTools", () => {
  it("groups by the module a tool comes from", () => {
    const out = describeTools(registryWith(["files.read", "files.write", "sql"]));
    expect(out).toContain("## files");
    expect(out).toContain("files.read");
    expect(out).toContain("## sql");
  });

  it("says the offered list may be shorter than this one", () => {
    /*
     * The whole point. Once the registry outgrows the per-turn cap the
     * offered set is narrowed by what the message looks like it is about, and
     * a tool absent from it is indistinguishable from one that does not
     * exist. Narrowing decides what is offered; the allow-list decides what
     * runs, so a name from here is enough to call it.
     */
    const out = describeTools(registryWith(["files.read"]));
    expect(out).toContain("may be shorter");
    expect(out).toContain("still");
  });

  it("marks what this conversation may not run", () => {
    const out = describeTools(registryWith(["files.read", "sql"]), ["files"]);
    expect(out).toContain("files.read —");
    expect(out).toContain("sql (not in this conversation)");
  });

  it("counts the ones it cannot name rather than pretending they are not there", () => {
    const registry = registryWith(["files.read"]);
    registry.register(
      {
        name: "chats.create",
        description: "restricted",
        inputSchema: { type: "object", properties: {} },
      },
      () => "ok",
      { floor: "safe" },
      { restricted: true },
    );
    const out = describeTools(registry);
    expect(out).toContain("1 tools you can name");
    expect(out).toContain("1 more that only certain conversations are granted");
    // Named nowhere: an agent that cannot reach it has no use for the name.
    expect(out).not.toContain("chats.create");
  });

  it("keeps a description to its first line", () => {
    const out = describeTools(registryWith(["files.read"]));
    expect(out).toContain("does files.read");
    expect(out).not.toContain("second line");
  });
});
