import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { RoleStore, agentConversationId, agentScope, formatRole, parseRole, type Role } from "./roles.js";

describe("roles", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-roles-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips a role through its file", () => {
    const role: Role = {
      name: "price-watch",
      description: "Watches a listing",
      brief: "You watch one listing.\n\nTell the owner when it drops.",
      memory: "own",
      tools: ["browser", "memory"],
      task: "cheap",
      schedule: "0 */6 * * *",
      prompt: "Look at the listing.",
    };
    const text = formatRole(role);
    expect(text.startsWith("---\nname: price-watch\ndescription: Watches a listing\ntools: browser, memory\n")).toBe(true);
    expect(parseRole(text, "price-watch")).toEqual(role);
    // The sparse form reads back sparse: no empty keys invented.
    const plain = parseRole(formatRole({ name: "research", description: "Looks things up", brief: "You look.", memory: "shared" }), "research");
    expect(plain).toEqual({ name: "research", description: "Looks things up", brief: "You look.", memory: "shared" });
    // A face the owner set rides along, as the three words it is.
    const faced = { ...plain, face: { hue: 210, eyes: "sparkle" as const } };
    expect(formatRole(faced)).toContain("face: hue 210, eyes sparkle\n");
    expect(parseRole(formatRole(faced), "research")).toEqual(faced);
    expect(parseRole("---\ndescription: d\nface: gait=3, hue:400\n---\nbody", "x").face).toEqual({ gait: 3, hue: 40 });
  });

  it("refuses what it could not read back", () => {
    expect(() => parseRole("no head", "x")).toThrow(/starts with a ---/);
    expect(() => parseRole("---\ndescription: d\n", "x")).toThrow(/never closes/);
    expect(() => parseRole("---\nname: x\ndescription: d\n---\n", "x")).toThrow(/brief/);
    expect(() => parseRole("---\nname: x\ndescription: d\ncolour: red\n---\nbody", "x")).toThrow(/unknown key "colour"/);
    expect(() => parseRole("---\nname: y\ndescription: d\n---\nbody", "x")).toThrow(/does not match its folder/);
    expect(() => parseRole("---\ndescription: d\nschedule: 0 4 * * *\n---\nbody", "x")).toThrow(/needs a prompt/);
    expect(() => parseRole("---\ndescription: d\nmemory: mine\n---\nbody", "x")).toThrow(/memory must be/);
    expect(() => parseRole("---\ndescription: d\ntools: browser, Shell!\n---\nbody", "x")).toThrow(/not a tool family/);
    expect(() => parseRole("---\n---\nbody", "Bad Name")).toThrow(/name must match/);
    expect(() => parseRole("---\ndescription: d\nface: eyes googly\n---\nbody", "x")).toThrow(/out of range/);
    expect(() => parseRole("---\ndescription: d\nface: colour red\n---\nbody", "x")).toThrow(/out of range/);
    expect(() => parseRole("---\ndescription: d\nface: size big\n---\nbody", "x")).toThrow(/is not "hue/);
    // A picked colour rides along as hex, lowercased.
    const painted = parseRole("---\ndescription: d\nface: colour #3B82F6, gait 1\n---\nbody", "x");
    expect(painted.face).toEqual({ colour: "#3b82f6", gait: 1 });
    expect(formatRole({ ...painted, name: "x", memory: "own", description: "d", brief: "body" })).toContain("face: colour #3b82f6, gait 1\n");
  });

  it("lists what is on disk, names what does not parse, and reads an edit at once", () => {
    const store = new RoleStore(ws);
    expect(store.list()).toEqual({ roles: [], invalid: [] });
    const written = store.write({ name: "research", description: "Looks things up", brief: "You look things up.", memory: "own" });
    expect(written).toMatchObject({ name: "research", path: "agents/research/agent.md", folder: "agents/research" });
    mkdirSync(join(root, "agents", "broken"), { recursive: true });
    writeFileSync(join(root, "agents", "broken", "agent.md"), "---\nname: broken\n---\nbody\n", "utf8");
    // A folder with no agent.md is not an agent and is left alone.
    mkdirSync(join(root, "agents", "offload-test"), { recursive: true });
    const { roles, invalid } = store.list();
    expect(roles.map((r) => r.name)).toEqual(["research"]);
    expect(roles[0]!.tools).toBeUndefined();
    expect(invalid).toEqual([{ name: "broken", path: "agents/broken/agent.md", reason: expect.stringMatching(/description/) }]);
    // The owner edits the file; the next read is the new brief.
    writeFileSync(
      join(root, "agents", "research", "agent.md"),
      "---\nname: research\ndescription: Looks things up, carefully\ntools: browser\n---\nYou look things up, carefully.\n",
      "utf8",
    );
    expect(store.get("research")).toMatchObject({ description: "Looks things up, carefully", tools: ["browser"], brief: "You look things up, carefully." });
    expect(store.exists("research")).toBe(true);
    expect(store.get("broken")).toBeUndefined();
    expect(store.get("../etc")).toBeUndefined();
    expect(store.exists("../etc")).toBe(false);
    // Removing an agent that made things keeps its folder; an empty one goes.
    writeFileSync(join(root, "agents", "research", "notes.md"), "kettles\n", "utf8");
    expect(store.remove("research")).toBe(true);
    expect(store.remove("research")).toBe(false);
    expect(existsSync(join(root, "agents", "research", "notes.md"))).toBe(true);
    expect(existsSync(join(root, "agents", "research", "agent.md"))).toBe(false);
    store.write({ name: "fleeting", description: "d", brief: "b", memory: "own" });
    store.remove("fleeting");
    expect(existsSync(join(root, "agents", "fleeting"))).toBe(false);
  });

  it("moves a file from before agents had folders into one", () => {
    const store = new RoleStore(ws);
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "old.md"), "---\nname: old\ndescription: From before\n---\nYou were a file.\n", "utf8");
    expect(store.exists("old")).toBe(true);
    expect(store.list().roles.map((r) => r.path)).toEqual(["agents/old/agent.md"]);
    expect(existsSync(join(root, "agents", "old.md"))).toBe(false);
    expect(store.get("old")).toMatchObject({ description: "From before", folder: "agents/old" });
    // A note left beside the roles has no frontmatter: not an agent, not moved.
    writeFileSync(join(root, "agents", "old-log.md"), "# Running record\n\n- did a thing\n", "utf8");
    expect(store.list().roles.map((r) => r.name)).toEqual(["old"]);
    expect(store.list().invalid).toEqual([]);
    expect(store.exists("old-log")).toBe(false);
    expect(existsSync(join(root, "agents", "old-log.md"))).toBe(true);
    expect(agentScope("research")).toBe("agent:research");
    expect(agentConversationId("research")).toBe("agent:research");
  });
});
