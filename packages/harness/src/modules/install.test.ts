import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { installModule, isGitSource, nameFromSource, removeModule, updateModule, type Runner } from "./install.js";
import { readWorkspaceModules } from "./workspace.js";

describe("installing a module", () => {
  let root: string;
  let ws: Workspace;
  let src: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-install-"));
    ws = Workspace.open(root);
    src = mkdtempSync(join(tmpdir(), "kos-module-src-"));
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  function source(name: string, manifest: unknown): string {
    const dir = join(src, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "module.json"), JSON.stringify(manifest), "utf8");
    writeFileSync(join(dir, "server.mjs"), "", "utf8");
    return dir;
  }

  it("tells a git URL from a folder, and never passes git an option", () => {
    expect(isGitSource("https://github.com/x/kos-weather.git")).toBe(true);
    expect(isGitSource("git@github.com:x/kos-weather.git")).toBe(true);
    expect(isGitSource("/tmp/somewhere")).toBe(false);
    expect(isGitSource("--upload-pack=evil")).toBe(false);
    expect(nameFromSource("https://github.com/x/KOS-Weather.git")).toBe("kos-weather");
    expect(nameFromSource("/tmp/My Module/")).toBe("my-module");
  });

  it("copies a folder in, checks it is a module, and leaves it off", async () => {
    const dir = source("weather", { name: "weather", description: "Weather", command: "node", args: ["server.mjs"] });
    const made = await installModule(ws, dir);
    expect(made).toMatchObject({ name: "weather", dir: "modules/weather", origin: null });
    expect(readWorkspaceModules(ws).modules.map((m) => m.manifest.name)).toEqual(["weather"]);
  });

  it("removes a folder that turns out not to be a module, and says why", async () => {
    const dir = source("junk", { name: "junk" });
    await expect(installModule(ws, dir)).rejects.toThrow(/not a module: description is required/);
    expect(existsSync(join(root, "modules", "junk"))).toBe(false);
  });

  it("clones a repository through git, then updates it with a pull", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (file, args, cwd) => {
      calls.push([file, ...args]);
      if (args[0] === "clone") {
        const dest = args.at(-1)!;
        mkdirSync(join(dest, ".git"), { recursive: true });
        writeFileSync(join(dest, "module.json"), JSON.stringify({ name: "weather", description: "Weather", command: "node" }), "utf8");
      }
      if (args[0] === "remote") return { stdout: "https://github.com/x/weather.git\n" };
      void cwd;
      return { stdout: "" };
    };
    const made = await installModule(ws, "https://github.com/x/weather.git", { run: runner });
    expect(made.origin).toBe("https://github.com/x/weather.git");
    expect(calls[0]).toEqual(["git", "clone", "--depth", "1", "--quiet", "--", "https://github.com/x/weather.git", ws.resolve("modules/weather")]);
    const updated = await updateModule(ws, "weather", { run: runner });
    expect(updated.name).toBe("weather");
    expect(calls.some((c) => c[1] === "pull" && c.includes("--ff-only"))).toBe(true);
  });

  it("will not pull a module that did not come from a repository, and removes on request", async () => {
    const dir = source("local", { name: "local", description: "Local", command: "node" });
    await installModule(ws, dir);
    await expect(updateModule(ws, "local")).rejects.toThrow(/not installed from a repository/);
    removeModule(ws, "local");
    expect(readWorkspaceModules(ws).modules).toEqual([]);
    expect(() => removeModule(ws, "../etc")).toThrow(/not a module name/);
  });
});
