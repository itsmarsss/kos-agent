import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { Project } from "./manifest.js";
import { describeActive, describeProject, renderSchemas } from "./schema.js";

function project(slug: string, touched: number, status = "active"): Project {
  return {
    id: 1,
    name: slug,
    slug,
    type: "tracker",
    status: status as Project["status"],
    description: null,
    module: null,
    createdAt: 0,
    lastTouchedAt: touched,
  };
}

function workspace(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE budget_tx (id INTEGER PRIMARY KEY, amount REAL, posted_on TEXT);
    CREATE TABLE budget_cat (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE notes_items (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE settings (key TEXT, value TEXT);
  `);
  return db;
}

describe("describing a project's tables", () => {
  it("lists only that project's tables, with their columns", () => {
    const db = workspace();
    const schema = describeProject(db, "budget");
    db.close();
    expect(schema.tables).toEqual([
      { name: "budget_cat", columns: ["id", "label"] },
      { name: "budget_tx", columns: ["id", "amount", "posted_on"] },
    ]);
  });

  it("does not let a slug act as a wildcard", () => {
    // `_` and `%` are LIKE metacharacters. Unescaped, a slug containing one
    // would match tables belonging to other projects.
    const db = workspace();
    db.exec(`CREATE TABLE axb_t (id INTEGER)`);
    expect(describeProject(db, "a%b").tables).toEqual([]);
    expect(describeProject(db, "a_b").tables).toEqual([]);
    db.close();
  });

  it("covers active projects and skips ones with nothing to show", () => {
    const db = workspace();
    const schemas = describeActive(db, [
      project("budget", 2),
      project("notes", 1),
      project("empty", 3),
      project("budget_old", 9, "archived"),
    ]);
    db.close();
    expect(schemas.map((s) => s.slug)).toEqual(["budget", "notes"]);
  });
});

describe("rendering the tables section", () => {
  const budget = {
    slug: "budget",
    lastTouchedAt: 10,
    tables: [{ name: "budget_tx", columns: ["id", "amount"] }],
  };
  const notes = {
    slug: "notes",
    lastTouchedAt: 20,
    tables: [{ name: "notes_items", columns: ["id", "body"] }],
  };

  it("names each table with its columns", () => {
    const text = renderSchemas([budget])!;
    expect(text).toContain("## Tables");
    expect(text).toContain("- budget_tx: id, amount");
  });

  it("keeps slug order no matter which project was touched last", () => {
    /*
     * This sits in the cacheable prefix of every prompt. Ordered by recency
     * it would reshuffle whenever a project was touched, and every reshuffle
     * is a cache miss on the whole prefix.
     */
    const a = renderSchemas([notes, budget]);
    const b = renderSchemas([{ ...budget, lastTouchedAt: 99 }, notes]);
    expect(a).toBe(b);
    expect(a!.indexOf("budget_tx")).toBeLessThan(a!.indexOf("notes_items"));
  });

  it("drops the least recently touched project first when over budget", () => {
    const text = renderSchemas([budget, notes], 60)!;
    // notes (touched later) survives; budget (older) goes, and it says so.
    expect(text).toContain("notes_items");
    expect(text).not.toContain("budget_tx");
    expect(text).toContain("1 more project not shown");
  });

  it("never drops the last project, however small the budget", () => {
    const text = renderSchemas([budget], 1)!;
    expect(text).toContain("budget_tx");
  });

  it("is absent when there is nothing to describe", () => {
    expect(renderSchemas([])).toBeUndefined();
  });

  it("does not hand a longer sibling slug's tables to the shorter one", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE pantry_items (id INTEGER); CREATE TABLE pantry_2_items (id INTEGER);`);
    const mine = describeProject(db, "pantry", 0, ["pantry", "pantry_2"]);
    expect(mine.tables.map((t) => t.name)).toEqual(["pantry_items"]);
    expect(describeProject(db, "pantry_2", 0, ["pantry", "pantry_2"]).tables.map((t) => t.name)).toEqual(["pantry_2_items"]);
  });
});
