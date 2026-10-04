import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CronStore } from "../cron/store.js";
import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "../systems/manifest.js";
import { Migrator } from "../systems/migrate.js";
import { PageStore } from "../systems/pages.js";
import {
  checkBlueprint,
  extractBlueprint,
  instantiateBlueprint,
  tokenize,
  untokenize,
  writeBlueprintModule,
} from "./blueprint.js";
import { readWorkspaceModules } from "./workspace.js";

/**
 * A project, promoted and instantiated again.
 *
 * The property that matters: an instance made from the blueprint has the
 * same shape as the project it came from, under its own slug, with none of
 * the original's rows, and the migrator's ledger records how it got there.
 */
describe("a blueprint", () => {
  let root: string;
  let ws: Workspace;
  let manifest: ProjectManifest;
  let migrator: Migrator;
  let pages: PageStore;
  let crons: CronStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-blueprint-"));
    ws = Workspace.open(root);
    manifest = new ProjectManifest(ws.db);
    migrator = new Migrator(ws.db, manifest);
    pages = new PageStore(ws.db, ws, manifest);
    crons = new CronStore(ws.db);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  function budget(): string {
    const p = manifest.createProject({ name: "Household", type: "budget" });
    migrator.migrate(p.slug, {
      op: "create_table",
      table: "tx",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "amount", type: "REAL", notNull: true },
      ],
    });
    migrator.migrate(p.slug, { op: "add_column", table: "tx", column: { name: "note", type: "TEXT" } });
    ws.db.prepare(`INSERT INTO household_tx (amount, note) VALUES (40, 'groceries')`).run();
    pages.write(p.slug, {
      id: "spend",
      title: "Spend",
      widgets: [{ type: "stat", title: "Total", query: "SELECT SUM(amount) AS total FROM household_tx" }],
    });
    crons.create({ name: "weekly digest", schedule: "0 9 * * 1", type: "self_prompt", prompt: "Summarise household_tx for the week.", projectSlug: p.slug, enabled: true });
    return p.slug;
  }

  it("swaps a slug for the token and back, everywhere in a value", () => {
    const t = tokenize({ q: "SELECT * FROM household_tx", list: ["household_tx", "other"] }, "household");
    expect(t).toEqual({ q: "SELECT * FROM {{instance}}_tx", list: ["{{instance}}_tx", "other"] });
    expect(untokenize(t, "side_biz")).toEqual({ q: "SELECT * FROM side_biz_tx", list: ["side_biz_tx", "other"] });
  });

  it("carries a project's shape and leaves its rows behind", () => {
    const slug = budget();
    const { blueprint, derived } = extractBlueprint({ db: ws.db, manifest, migrator, pages, crons }, slug);
    expect(blueprint.type).toBe("budget");
    expect(blueprint.schema.map((s) => s.op)).toEqual(["create_table", "add_column"]);
    expect(blueprint.pages[0]?.widgets[0]).toMatchObject({ query: "SELECT SUM(amount) AS total FROM {{instance}}_tx" });
    expect(blueprint.jobs).toEqual([expect.objectContaining({ name: "weekly digest", prompt: "Summarise {{instance}}_tx for the week." })]);
    expect(derived).toEqual([]);
    expect(JSON.stringify(blueprint)).not.toContain("groceries");
    expect(checkBlueprint(blueprint)).toEqual([]);
  });

  it("reads the shape of a table the migrator did not make, and says so", () => {
    // A project older than the ledger, or one built with raw DDL, still
    // promotes: its columns come from the database instead of the ledger.
    const slug = budget();
    ws.db.exec(`CREATE TABLE household_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, stars INTEGER DEFAULT 3, tag TEXT DEFAULT 'misc')`);
    const { blueprint, derived } = extractBlueprint({ db: ws.db, manifest, migrator, pages, crons }, slug);
    expect(derived).toEqual(["household_notes"]);
    expect(blueprint.schema.at(-1)).toEqual({
      op: "create_table",
      table: "notes",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "body", type: "TEXT", notNull: true },
        { name: "stars", type: "INTEGER", default: 3 },
        { name: "tag", type: "TEXT", default: "misc" },
      ],
    });
    expect(checkBlueprint(blueprint)).toEqual([]);
    const made = instantiateBlueprint({ db: ws.db, manifest, migrator, pages, crons }, "b", blueprint, "Copy");
    expect((ws.db.prepare(`PRAGMA table_info(copy_notes)`).all() as { name: string }[]).map((c) => c.name)).toEqual(["id", "body", "stars", "tag"]);
    void made;
  });

  it("writes a module the loader reads back, and makes an instance from it", () => {
    const slug = budget();
    const { blueprint } = extractBlueprint({ db: ws.db, manifest, migrator, pages, crons }, slug);
    writeBlueprintModule(ws, "budget", "A budget with a weekly digest", blueprint);
    manifest.setModule(slug, "budget");
    const read = readWorkspaceModules(ws);
    expect(read.invalid).toEqual([]);
    const mod = read.modules[0]!;
    expect(mod.manifest.command).toBeUndefined();
    expect(mod.manifest.blueprint?.pages).toHaveLength(1);

    const made = instantiateBlueprint({ db: ws.db, manifest, migrator, pages, crons }, "budget", mod.manifest.blueprint!, "Side biz");
    expect(made).toMatchObject({ slug: "side_biz", module: "budget", type: "budget" });
    expect(manifest.listByModule("budget").map((p) => p.slug).sort()).toEqual(["household", "side_biz"]);
    // Its own tables, with the full shape, and nothing in them.
    const cols = (ws.db.prepare(`PRAGMA table_info(side_biz_tx)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "amount", "note"]);
    expect((ws.db.prepare(`SELECT COUNT(*) AS n FROM side_biz_tx`).get() as { n: number }).n).toBe(0);
    expect(migrator.history("side_biz")).toHaveLength(2);
    // Its page reads its own table; its job is there and off.
    const page = pages.get("side_biz_spend");
    expect(page?.spec.widgets[0]).toMatchObject({ query: "SELECT SUM(amount) AS total FROM side_biz_tx" });
    const job = crons.list().find((j) => j.projectSlug === "side_biz");
    expect(job).toMatchObject({ enabled: false, prompt: "Summarise side_biz_tx for the week." });
  });

  it("refuses a blueprint that would not apply", () => {
    expect(checkBlueprint({ type: "x", instancing: "multi", schema: [], pages: [{ id: "p", title: "P", widgets: [{ type: "stat", title: "T", query: "DROP TABLE {{instance}}_tx" } as never] }], jobs: [] })).not.toEqual([]);
  });

  it("keeps a second instance's tables apart from the first, slug prefix and all", () => {
    // "Pantry" and "Pantry 2": the second slug starts with the first. The
    // page store and the schema describer used to hand pantry_2's tables to
    // pantry by prefix, so the second instance could not even write its page.
    const slug = budget();
    const { blueprint } = extractBlueprint({ db: ws.db, manifest, migrator, pages, crons }, slug);
    const second = instantiateBlueprint({ db: ws.db, manifest, migrator, pages, crons }, "b", blueprint, "Household 2");
    expect(second.slug).toBe("household_2");
    expect(pages.get("household_2_spend")?.spec.widgets[0]).toMatchObject({ query: "SELECT SUM(amount) AS total FROM household_2_tx" });
  });

  it("leaves nothing behind when an instance cannot be completed", () => {
    const bad = {
      type: "x",
      instancing: "multi" as const,
      schema: [],
      pages: [{ id: "p", title: "P", widgets: [{ type: "list", title: "L", mutate: { table: "{{instance}}_missing", columns: ["a"] } } as never] }],
      jobs: [],
    };
    expect(() => instantiateBlueprint({ db: ws.db, manifest, migrator, pages, crons }, "bad", bad, "Half")).toThrow();
    expect(manifest.get("half")).toBeUndefined();
  });
});
