import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { Migrator } from "./migrate.js";
import { PageStore } from "./pages.js";
import { deleteProject } from "./remove.js";

function tableExists(ws: Workspace, name: string): boolean {
  return !!ws.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
}

describe("deleteProject cascade", () => {
  let root: string;
  let ws: Workspace;
  let manifest: ProjectManifest;
  let migrator: Migrator;
  let pages: PageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-remove-"));
    ws = Workspace.open(root);
    manifest = new ProjectManifest(ws.db);
    migrator = new Migrator(ws.db, manifest);
    pages = new PageStore(ws.db, ws, manifest);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A project with one table, one page row, and a page file on disk. */
  function seed(name: string): string {
    const p = manifest.createProject({ name, type: "tracker" });
    migrator.migrate(p.slug, {
      op: "create_table",
      table: "items",
      columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
    });
    ws.db
      .prepare(
        `INSERT INTO pages (id, project_slug, title, path, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        `${p.slug}_home`,
        p.slug,
        "Home",
        join("projects", p.slug, "pages", "home.json"),
        0,
      );
    const dir = ws.resolve(join("projects", p.slug, "pages"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "home.json"), "{}");
    return p.slug;
  }

  it("drops the target's tables, ledger, pages, and folder", () => {
    const slug = seed("Pantry");
    const result = deleteProject({ manifest, migrator, pages }, slug);

    expect(result).toEqual({
      slug: "pantry",
      tablesDropped: ["pantry_items"],
      pagesRemoved: 1,
    });
    expect(manifest.get("pantry")).toBeUndefined();
    expect(tableExists(ws, "pantry_items")).toBe(false);
    expect(migrator.history("pantry")).toEqual([]);
    expect(pages.list("pantry")).toEqual([]);
    expect(existsSync(ws.resolve(join("projects", "pantry")))).toBe(false);
  });

  it("leaves a sibling under a longer slug untouched", () => {
    seed("Pantry"); // slug: pantry
    const sibling = seed("Pantry 2"); // slug: pantry_2, shares the prefix
    expect(sibling).toBe("pantry_2");

    const result = deleteProject({ manifest, migrator, pages }, "pantry");

    // Only pantry_items, never pantry_2_items.
    expect(result.tablesDropped).toEqual(["pantry_items"]);
    expect(tableExists(ws, "pantry_2_items")).toBe(true);
    expect(manifest.get("pantry_2")).toBeDefined();
    expect(migrator.history("pantry_2").length).toBe(1);
    expect(pages.list("pantry_2").length).toBe(1);
    expect(existsSync(ws.resolve(join("projects", "pantry_2")))).toBe(true);
  });

  it("throws on an unknown project", () => {
    expect(() => deleteProject({ manifest, migrator, pages }, "nope")).toThrow(
      /unknown project/,
    );
  });
});
