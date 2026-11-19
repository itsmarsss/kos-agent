import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import {
  adoptUnpinned,
  enabledServers,
  parseModuleManifest,
  parseModuleSettings,
  pinModule,
  readWorkspaceModules,
  repinModule,
  runnableModules,
  scaffoldModule,
  serverFor,
  withBuiltinEnabled,
  withModuleEnabled,
  type ModuleSettings,
} from "./workspace.js";

/** Settings with these modules switched on by the owner, as their folders are now. */
function switchedOn(ws: Workspace, ...names: string[]): ModuleSettings {
  let settings: ModuleSettings = { enabled: [], disabledBuiltins: [] };
  const modules = readWorkspaceModules(ws).modules;
  for (const name of names) {
    const module = modules.find((m) => m.manifest.name === name);
    settings = withModuleEnabled(settings, name, true, module ? pinModule(ws, module) : undefined);
  }
  return settings;
}

describe("a module's manifest", () => {
  it("needs a name that is its directory, a description and a command", () => {
    expect(parseModuleManifest({ name: "notes", description: "Notes", command: "node", args: ["s.mjs"], tools: { list: "safe", bogus: "maybe" } }, "notes"))
      .toEqual({ name: "notes", description: "Notes", command: "node", args: ["s.mjs"], tools: { list: "safe" } });
    expect(() => parseModuleManifest({ name: "notes", description: "d", command: "node" }, "other")).toThrow(/directory/);
    expect(() => parseModuleManifest({ name: "notes", description: "d" }, "notes")).toThrow(/command/);
    expect(() => parseModuleManifest({ name: "../x", description: "d", command: "node" }, "../x")).toThrow(/name/);
  });
});

describe("modules in a workspace", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-wsmod-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the valid ones and says why the others are not", () => {
    mkdirSync(join(root, "modules", "good"), { recursive: true });
    writeFileSync(join(root, "modules", "good", "module.json"), JSON.stringify({ name: "good", description: "ok", command: "node" }));
    mkdirSync(join(root, "modules", "bare"), { recursive: true });
    const { modules, invalid } = readWorkspaceModules(ws);
    expect(modules.map((m) => [m.manifest.name, m.dir])).toEqual([["good", "modules/good"]]);
    expect(invalid).toEqual([{ name: "bare", reason: "no module.json" }]);
    // Another workspace, inside this one's folder so it goes with it.
    const empty = Workspace.open(mkdtempSync(join(root, "empty-")));
    try {
      expect(readWorkspaceModules(empty)).toEqual({ modules: [], invalid: [] });
    } finally {
      empty.close();
    }
  });

  it("runs a module from its own folder, jailed, with the floors it declared", () => {
    const mod = { manifest: { name: "m", description: "d", command: "node", args: ["server.mjs"], tools: { read: "safe" as const } }, dir: "modules/m" };
    const plain = serverFor(mod, { workspaceRoot: "/w", jail: false });
    expect(plain).toEqual({ command: "node", args: ["server.mjs"], cwd: "/w/modules/m", tools: { read: "safe" } });
    if (process.platform === "darwin") {
      const jailed = serverFor(mod, { workspaceRoot: "/w", jail: true });
      expect(jailed.command).toBe("/usr/bin/sandbox-exec");
      expect(jailed.args!.slice(-2)).toEqual(["node", "server.mjs"]);
    }
  });

  it("reads a blueprint-only module, and never tries to start one", () => {
    const dir = join(ws.root, "modules", "budget");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "module.json"),
      JSON.stringify({ name: "budget", description: "A budget", blueprint: { type: "budget", schema: [], pages: [], jobs: [] } }),
      "utf8",
    );
    const { modules, invalid } = readWorkspaceModules(ws);
    expect(invalid).toEqual([]);
    expect(modules[0]?.manifest.blueprint?.type).toBe("budget");
    expect(enabledServers(ws, switchedOn(ws, "budget"), false)).toEqual({});
  });

  it("serves only what the owner switched on, and off is the default", () => {
    scaffoldModule(ws, "one", "One");
    scaffoldModule(ws, "two", "Two");
    expect(Object.keys(enabledServers(ws, { enabled: [], disabledBuiltins: [] }, false))).toEqual([]);
    expect(Object.keys(enabledServers(ws, switchedOn(ws, "two", "ghost"), false))).toEqual(["two"]);
    expect(parseModuleSettings(undefined)).toEqual({ enabled: [], disabledBuiltins: [] });
    const on = withModuleEnabled({ enabled: [], disabledBuiltins: [] }, "two", true);
    expect(on).toEqual({ enabled: ["two"], disabledBuiltins: [] });
    expect(withModuleEnabled(on, "two", false)).toEqual({ enabled: [], disabledBuiltins: [] });
    const off = withBuiltinEnabled(on, "tasks", false);
    expect(off).toEqual({ enabled: ["two"], disabledBuiltins: ["tasks"] });
    expect(withBuiltinEnabled(off, "tasks", true).disabledBuiltins).toEqual([]);
  });

  it("runs a module only as the owner switched it on: a changed folder waits, and the floors are the ones they saw", () => {
    scaffoldModule(ws, "notes", "Notes");
    const settings = switchedOn(ws, "notes");
    expect(enabledServers(ws, settings, false)["notes"]).toMatchObject({ command: "node", args: ["server.mjs"], tools: { greet: "safe" } });
    // The agent rewrites the floors and the program: neither runs.
    const manifest = join(root, "modules", "notes", "module.json");
    writeFileSync(manifest, JSON.stringify({ name: "notes", description: "Notes", command: "sh", args: ["-c", "id"], risk: "safe", tools: { greet: "safe", wipe: "safe" } }));
    const told: string[] = [];
    expect(enabledServers(ws, settings, false, () => [], (name) => told.push(name))).toEqual({});
    expect(told).toEqual(["notes"]);
    expect(runnableModules(ws, settings)).toEqual([]);
    // Any file in the folder counts, not only the manifest.
    const fresh = switchedOn(ws, "notes");
    expect(runnableModules(ws, fresh)).toEqual(["notes"]);
    writeFileSync(join(root, "modules", "notes", "helper.mjs"), "export {}");
    expect(runnableModules(ws, fresh)).toEqual([]);
    // Unpinned, as one switched on before pins were kept: it waits too.
    expect(runnableModules(ws, { enabled: ["notes"], disabledBuiltins: [] })).toEqual([]);
    // The pin survives the settings' round trip, and switching off drops it.
    const again = switchedOn(ws, "notes");
    expect(parseModuleSettings(JSON.parse(JSON.stringify(again)))).toEqual(again);
    expect(withModuleEnabled(again, "notes", false)).toEqual({ enabled: [], disabledBuiltins: [] });
  });

  it("pins a link by its target, leaves data/ out, and adopts what was on before pins", () => {
    scaffoldModule(ws, "linked", "Linked");
    const dir = join(root, "modules", "linked");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync("../../../kos.sqlite", join(dir, "node_modules", "dep"));
    const module = () => readWorkspaceModules(ws).modules.find((m) => m.manifest.name === "linked")!;
    const pinned = pinModule(ws, module()).hash;
    // The server's own data is not its code.
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "notes.json"), "[]");
    expect(pinModule(ws, module()).hash).toBe(pinned);
    // A link pointed elsewhere is another module.
    rmSync(join(dir, "node_modules", "dep"));
    symlinkSync("../../../profile.json", join(dir, "node_modules", "dep"));
    expect(pinModule(ws, module()).hash).not.toBe(pinned);
    // Switched on before pins were kept: trusted once as it is, and said.
    const { settings, adopted } = adoptUnpinned(ws, { enabled: ["linked", "ghost"], disabledBuiltins: [] });
    expect(adopted).toEqual(["linked"]);
    expect(runnableModules(ws, settings)).toEqual(["linked"]);
    expect(adoptUnpinned(ws, settings).adopted).toEqual([]);
    // The owner's own update keeps one that was on running as it is now; one that was off stays off.
    writeFileSync(join(dir, "server.mjs"), "// updated");
    expect(runnableModules(ws, settings)).toEqual([]);
    expect(runnableModules(ws, repinModule(ws, settings, "linked")!)).toEqual(["linked"]);
    expect(repinModule(ws, { enabled: [], disabledBuiltins: [] }, "linked")).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")("jails a module's server away from KOS's own files and its own folder", () => {
    const mod = { manifest: { name: "m", description: "d", command: "node" }, dir: "modules/m" };
    const profile = serverFor(mod, { workspaceRoot: "/w", jail: true }).args![1]!;
    expect(profile).toMatch(/\(deny file-read\* [^\n]*\(subpath "\/w\/kos\.sqlite"\)/);
    expect(profile).toMatch(/\(deny file-write\* [^\n]*\(subpath "\/w\/kos\.sqlite-wal"\)/);
    expect(profile).toMatch(/\(deny file-write\* [^\n]*\(subpath "\/w\/modules\/m"\)/);
    expect(profile).toMatch(/\(allow file-write\* [^\n]*\(subpath "\/w\/modules\/m\/data"\)/);
  });

  it("scaffolds a module that reads back valid, and refuses to clobber one", () => {
    const made = scaffoldModule(ws, "hello", "Says hello");
    expect(made.files).toEqual(["modules/hello/module.json", "modules/hello/server.mjs"]);
    expect(readWorkspaceModules(ws).modules[0]!.manifest).toMatchObject({ name: "hello", command: "node", args: ["server.mjs"], tools: { greet: "safe" } });
    expect(() => scaffoldModule(ws, "hello", "again")).toThrow(/already exists/);
    expect(() => scaffoldModule(ws, "Bad Name", "x")).toThrow(/not a module name/);
  });
});
