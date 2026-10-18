import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";

describe("ProjectManifest", () => {
  let root: string;
  let ws: Workspace;
  let manifest: ProjectManifest;
  let clock: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-manifest-"));
    ws = Workspace.open(root);
    clock = 1000;
    manifest = new ProjectManifest(ws.db, () => clock);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a project with a derived slug and active status", () => {
    const p = manifest.createProject({ name: "Budget 2026", type: "budget" });
    expect(p.slug).toBe("budget_2026");
    expect(p.status).toBe("active");
    expect(p.createdAt).toBe(1000);
    expect(manifest.get("budget_2026")?.name).toBe("Budget 2026");
  });

  it("disambiguates colliding slugs", () => {
    const a = manifest.createProject({ name: "Budget", type: "budget" });
    const b = manifest.createProject({ name: "budget!", type: "budget" });
    expect(a.slug).toBe("budget");
    expect(b.slug).toBe("budget_2");
  });

  it("touch and setStatus update freshness and lifecycle", () => {
    manifest.createProject({ name: "Plan", type: "study" });
    clock = 5000;
    manifest.touchProject("plan");
    expect(manifest.get("plan")?.lastTouchedAt).toBe(5000);
    manifest.setStatus("plan", "archived");
    expect(manifest.get("plan")?.status).toBe("archived");
  });

  it("keeps a colour the owner gave a project, as lowercase hex, and lets it go", () => {
    manifest.createProject({ name: "Garden", type: "notes" });
    expect(manifest.get("garden")?.colour).toBeNull();
    manifest.setColour("garden", "#3B82F6");
    expect(manifest.get("garden")?.colour).toBe("#3b82f6");
    expect(() => manifest.setColour("garden", "blue")).toThrow(/#rrggbb/);
    manifest.setColour("garden", null);
    expect(manifest.get("garden")?.colour).toBeNull();
  });

  it("lets the name, what it is for and the kind change, and refuses a name another has", () => {
    manifest.createProject({ name: "Garden", type: "notes" });
    manifest.createProject({ name: "Shed", type: "notes" });
    const changed = manifest.update("garden", { name: "Back garden", description: "Beds and the greenhouse", type: "tracker" });
    expect(changed).toMatchObject({ slug: "garden", name: "Back garden", description: "Beds and the greenhouse", type: "tracker" });
    expect(manifest.update("garden", { description: "  " }).description).toBeNull();
    expect(() => manifest.update("garden", { name: "Shed" })).toThrow(/another project is called Shed/);
    expect(() => manifest.update("garden", { name: " " })).toThrow(/needs a name/);
    expect(() => manifest.update("nope", { name: "x" })).toThrow(/no project/);
  });

  it("lists projects, optionally filtered by status", () => {
    manifest.createProject({ name: "A", type: "x" });
    manifest.createProject({ name: "B", type: "x", status: "done" });
    expect(manifest.list()).toHaveLength(2);
    expect(manifest.list("done").map((p) => p.name)).toEqual(["B"]);
  });

  it("namespaces project tables", () => {
    const p = manifest.createProject({ name: "Budget", type: "budget" });
    expect(manifest.tableName(p.slug, "tx")).toBe("budget_tx");
  });

  it("allows multiple instances of a multi-instance module", () => {
    manifest.createProject({ name: "Household 2026", type: "budget", module: "budget" });
    manifest.createProject({ name: "Side Biz", type: "budget", module: "budget" });
    expect(manifest.listByModule("budget")).toHaveLength(2);
  });

  it("rejects a second instance of a single-instance module", () => {
    manifest.createProject({
      name: "Discord Formatter",
      type: "tool",
      module: "discord-fmt",
      instancing: "single",
    });
    expect(() =>
      manifest.createProject({
        name: "Discord Formatter 2",
        type: "tool",
        module: "discord-fmt",
        instancing: "single",
      }),
    ).toThrow(/single-instance/);
  });

  it("treats projects without a module as embedded (null module)", () => {
    const p = manifest.createProject({ name: "Ad Hoc", type: "notes" });
    expect(p.module).toBeNull();
  });
});
