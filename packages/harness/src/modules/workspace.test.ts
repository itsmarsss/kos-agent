import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import {
  enabledServers,
  parseModuleManifest,
  parseModuleSettings,
  readWorkspaceModules,
  scaffoldModule,
  serverFor,
  withBuiltinEnabled,
  withModuleEnabled,
} from "./workspace.js";

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
    expect(readWorkspaceModules(Workspace.open(mkdtempSync(join(tmpdir(), "kos-empty-"))))).toEqual({ modules: [], invalid: [] });
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

  it("serves only what the owner switched on, and off is the default", () => {
    scaffoldModule(ws, "one", "One");
    scaffoldModule(ws, "two", "Two");
    expect(Object.keys(enabledServers(ws, [], false))).toEqual([]);
    expect(Object.keys(enabledServers(ws, ["two", "ghost"], false))).toEqual(["two"]);
    expect(parseModuleSettings(undefined)).toEqual({ enabled: [], disabledBuiltins: [] });
    const on = withModuleEnabled({ enabled: [], disabledBuiltins: [] }, "two", true);
    expect(on).toEqual({ enabled: ["two"], disabledBuiltins: [] });
    expect(withModuleEnabled(on, "two", false)).toEqual({ enabled: [], disabledBuiltins: [] });
    const off = withBuiltinEnabled(on, "tasks", false);
    expect(off).toEqual({ enabled: ["two"], disabledBuiltins: ["tasks"] });
    expect(withBuiltinEnabled(off, "tasks", true).disabledBuiltins).toEqual([]);
  });

  it("scaffolds a module that reads back valid, and refuses to clobber one", () => {
    const made = scaffoldModule(ws, "hello", "Says hello");
    expect(made.files).toEqual(["modules/hello/module.json", "modules/hello/server.mjs"]);
    expect(readWorkspaceModules(ws).modules[0]!.manifest).toMatchObject({ name: "hello", command: "node", args: ["server.mjs"], tools: { greet: "safe" } });
    expect(() => scaffoldModule(ws, "hello", "again")).toThrow(/already exists/);
    expect(() => scaffoldModule(ws, "Bad Name", "x")).toThrow(/not a module name/);
  });
});
