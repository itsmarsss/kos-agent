import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../store/db.js";
import { codeOf, fence, isKernelTable, ownedBy, ownerOf, planOf, readsSchema, writesKernelTable, type Reach } from "./fence.js";

/**
 * The sql tool is for the calling project's tables. KOS's own, another
 * project's and the schema itself are refused outside Maintenance, and the
 * trust tables are written by nobody. What a statement reaches is judged by
 * SQLite's plan for it, so the database here is a real one.
 */
describe("the fence around the tables", () => {
  let db: Db;
  const projects = [
    { slug: "books", name: "Books" },
    { slug: "pantry", name: "Pantry" },
    { slug: "pantry_2", name: "Second pantry" },
    { slug: "maintenance", name: "Maintenance" },
  ];
  const reach = (project: string | undefined): Reach => ({ project, projects });

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE books_items (id INTEGER PRIMARY KEY, title TEXT, pages INTEGER, settings TEXT, tags TEXT);
      CREATE INDEX books_items_title ON books_items (title);
      CREATE TABLE books_notes (id INTEGER PRIMARY KEY, text TEXT);
      CREATE TABLE pantry_items (id INTEGER PRIMARY KEY);
      CREATE TABLE pantry_2_items (id INTEGER PRIMARY KEY);
      CREATE TABLE tx (id INTEGER PRIMARY KEY);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, messages TEXT);
      CREATE INDEX chat_sessions_messages ON chat_sessions (messages);
      CREATE TABLE crons (id INTEGER PRIMARY KEY);
      CREATE TABLE pages (id TEXT PRIMARY KEY);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE pending_actions (id INTEGER PRIMARY KEY, status TEXT);
      CREATE TABLE pending_messages (id INTEGER PRIMARY KEY, conversation_id TEXT, text TEXT);
      CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, platform TEXT, public_key TEXT, paired_at INTEGER);
      CREATE VIRTUAL TABLE memory_facts_fts USING fts5(value);
      CREATE VIEW books_recent AS SELECT id, messages FROM chat_sessions;
    `);
  });

  afterEach(() => db.close());

  it("knows KOS's tables by name and by family", () => {
    expect(isKernelTable("conversations")).toBe(true);
    expect(isKernelTable("memory_vec_256_chunks")).toBe(true);
    expect(isKernelTable("sqlite_master")).toBe(true);
    expect(isKernelTable("books_items")).toBe(false);
    expect(isKernelTable("tx")).toBe(false);
  });

  it("finds the tables a statement reaches by its plan, not its words", () => {
    expect(planOf(db, "SELECT * FROM books_items WHERE pages > 1 AND settings = 'conversations'")?.reads).toEqual(["books_items"]);
    expect(planOf(db, "SELECT title FROM books_items WHERE title = ?", ["x"])?.reads).toEqual(["books_items"]);
    expect(planOf(db, "insert into Books_Notes (text) values ('crons')")?.writes).toEqual(["books_notes"]);
    expect(planOf(db, "select name from sqlite_master")?.reads).toEqual(["sqlite_master"]);
    expect(planOf(db, "SELECT * FROM temp.sqlite_master")?.elsewhere).toBe(true);
    // Nothing to judge in a statement that does not compile.
    expect(planOf(db, "SELECT * FROM books_missing")).toBeUndefined();
    expect(planOf(db, "SELECT * FROM books_items WHERE id = ?")).toBeUndefined();
  });

  it("blanks values and comments, keeping quoted names", () => {
    expect(codeOf(`SELECT 'it''s' -- crons\nFROM "books items" /* pages */`).replace(/\s+/g, " ").trim()).toBe(`SELECT FROM "books items"`);
    expect(codeOf("SELECT * FROM 'crons'", "keep")).toBe("SELECT * FROM 'crons'");
  });

  it("knows whose a table is by its prefix, the longest slug winning", () => {
    expect(ownedBy("books_items", "books", ["books", "pantry", "pantry_2"])).toBe(true);
    expect(ownedBy("pantry_items", "pantry", ["books", "pantry", "pantry_2"])).toBe(true);
    expect(ownedBy("pantry_2_items", "pantry", ["books", "pantry", "pantry_2"])).toBe(false);
    expect(ownedBy("pantry_2_items", "pantry_2", ["books", "pantry", "pantry_2"])).toBe(true);
    expect(ownedBy("tx", "books", [])).toBe(false);
    expect(ownerOf("pantry_2_items", projects)?.name).toBe("Second pantry");
    expect(ownerOf("tx", projects)).toBeUndefined();
    expect(readsSchema("SELECT name FROM sqlite_master")).toBe(true);
    expect(readsSchema("  PRAGMA table_info(books_items)")).toBe(true);
    expect(readsSchema("SELECT * FROM books_items")).toBe(false);
    // The catalogue by its table-valued functions and page stats, unnamed.
    expect(readsSchema("SELECT name FROM pragma_table_list()")).toBe(true);
    expect(readsSchema("SELECT * FROM PRAGMA_TABLE_INFO('cr'||'ons')")).toBe(true);
    expect(readsSchema("SELECT name FROM dbstat")).toBe(true);
  });

  it("refuses a project's chat the catalogue by pragma functions and dbstat", () => {
    for (const sql of ["SELECT name FROM pragma_table_list()", "SELECT name FROM pragma_table_info('crons')", "SELECT name FROM dbstat", "SELECT * FROM 'dbstat'", "PRAGMA table_info(books_items)", "/* hi */ PRAGMA table_list"]) {
      expect(fence(db, sql, reach("books")).ok, sql).toBe(false);
    }
  });

  it("lets a project's own columns and values be named like KOS's tables", () => {
    expect(fence(db, "INSERT INTO books_items (title, pages, settings) VALUES ('settings', ?, 'crons')", reach("books"), [320])).toEqual({ ok: true });
    expect(fence(db, "SELECT pages, settings FROM books_items WHERE title = 'pages' -- not crons", reach("books"))).toEqual({ ok: true });
    expect(fence(db, "UPDATE books_items SET pages = pages + 1 WHERE settings LIKE '%sqlite_master%'", reach("books"))).toEqual({ ok: true });
  });

  it("still refuses KOS's tables named in quotes or behind a comment", () => {
    for (const sql of ["SELECT * FROM 'crons'", 'SELECT * FROM "crons"', "SELECT * FROM [chat_sessions]", "SELECT * FROM/* books_items */crons", "SELECT * FROM 'sqlite_master'", "SELECT * FROM main.chat_sessions"]) {
      expect(fence(db, sql, reach("books")).ok, sql).toBe(false);
    }
  });

  it("judges CTEs, subqueries and joins by every table they open", () => {
    expect(fence(db, "WITH b AS (SELECT * FROM books_items) SELECT * FROM b JOIN books_notes USING (id)", reach("books"))).toEqual({ ok: true });
    expect(fence(db, "SELECT * FROM main.books_items", reach("books"))).toEqual({ ok: true });
    const hidden = fence(db, "WITH c AS (SELECT id FROM chat_sessions) SELECT * FROM books_items WHERE id IN (SELECT id FROM c)", reach("books"));
    expect(hidden.reason).toMatch(/chat_sessions: that table is KOS's own/);
    expect(fence(db, "SELECT * FROM books_items WHERE EXISTS (SELECT 1 FROM settings)", reach("books")).ok).toBe(false);
    expect(fence(db, "SELECT * FROM books_items JOIN pantry_items USING (id)", reach("books")).reason).toMatch(/pantry_items is the Pantry project's/);
    // Read through an index alone, the table is still the one reached.
    expect(fence(db, "SELECT messages FROM chat_sessions WHERE messages > ''", reach("books")).ok).toBe(false);
  });

  it("refuses a view over KOS's tables by what it reads", () => {
    const view = fence(db, "SELECT * FROM books_recent", reach("books"));
    expect(view.ok).toBe(false);
    expect(view.reason).toMatch(/chat_sessions/);
  });

  it("lets JSON be taken apart, and no other virtual table", () => {
    expect(fence(db, "SELECT b.id, j.value FROM books_items b, json_each(b.tags) j", reach("books"))).toEqual({ ok: true });
    expect(fence(db, "SELECT * FROM json_each(?)", reach("books"), ["[1]"])).toEqual({ ok: true });
    expect(fence(db, "SELECT * FROM memory_facts_fts", reach("books")).ok).toBe(false);
    expect(fence(db, "SELECT * FROM json_each('[]'), 'memory_facts_fts'", reach("books")).ok).toBe(false);
    // A call that never runs does not cover a virtual table that does.
    expect(fence(db, "SELECT * FROM 'dbstat' WHERE 0 AND EXISTS (SELECT 1 FROM json_each('[]'))", reach("books")).ok).toBe(false);
    expect(fence(db, "SELECT * FROM 'memory_facts_fts' WHERE 0 AND EXISTS (SELECT 1 FROM json_each('[]'))", reach("books")).ok).toBe(false);
  });

  it("keeps EXPLAIN for Maintenance", () => {
    expect(fence(db, "EXPLAIN SELECT * FROM chat_sessions", reach("books")).ok).toBe(false);
    expect(fence(db, "EXPLAIN SELECT * FROM chat_sessions", reach("maintenance"))).toEqual({ ok: true });
  });

  it("lets a statement that does not compile through, for SQLite to say why", () => {
    expect(fence(db, "SELECT * FROM books_missing", reach("books"))).toEqual({ ok: true });
  });

  it("lets a chat build the project it made, rows and all, and nothing else", () => {
    const loose = { ...reach(undefined), made: ["books"] };
    expect(fence(db, "INSERT INTO books_items (title) VALUES ('x')", loose)).toEqual({ ok: true });
    const theirs = fence(db, "SELECT * FROM pantry_items", loose);
    expect(theirs.ok).toBe(false);
    expect(theirs.reason).toMatch(/reaches only the tables of Books/);
    // A project chat that made another reaches both.
    expect(fence(db, "SELECT * FROM books_items JOIN pantry_items USING (id)", { ...reach("pantry"), made: ["books"] })).toEqual({ ok: true });
  });

  it("lets a project read and write its own tables, and nothing it does not own", () => {
    expect(fence(db, "SELECT * FROM books_items JOIN books_notes USING (id)", reach("books"))).toEqual({ ok: true });
    expect(fence(db, "INSERT INTO books_items (title) VALUES ('x')", reach("books"))).toEqual({ ok: true });
    expect(fence(db, "SELECT 1", reach("books"))).toEqual({ ok: true });
    const theirs = fence(db, "SELECT * FROM pantry_items", reach("books"));
    expect(theirs.ok).toBe(false);
    expect(theirs.reason).toMatch(/pantry_items is the Pantry project's, not this project's/);
    expect(theirs.reason).toMatch(/reaches only the tables of Books/);
    expect(theirs.reason).toMatch(/@project:maintenance/);
    expect(fence(db, "SELECT * FROM tx", reach("books")).reason).toMatch(/tx belongs to no project/);
    // A longer sibling's table is the sibling's.
    expect(fence(db, "SELECT * FROM pantry_2_items", reach("pantry")).ok).toBe(false);
    expect(fence(db, "SELECT * FROM pantry_items", reach("pantry")).ok).toBe(true);
  });

  it("gives a chat with no project no table at all, and says where to ask", () => {
    const loose = fence(db, "SELECT * FROM books_items", reach(undefined));
    expect(loose.ok).toBe(false);
    expect(loose.reason).toMatch(/books_items is the Books project's/);
    expect(loose.reason).toMatch(/belongs to no project, so no table is its/);
    expect(loose.reason).toMatch(/ask KOS at the root/);
    expect(fence(db, "SELECT 1", reach(undefined))).toEqual({ ok: true });
  });

  it("keeps the schema for Maintenance", () => {
    const listing = fence(db, "SELECT name FROM sqlite_master WHERE type = 'table'", reach("books"));
    expect(listing.ok).toBe(false);
    expect(listing.reason).toMatch(/schema is Maintenance's to read/);
    expect(fence(db, "PRAGMA table_info(books_items)", reach("books")).ok).toBe(false);
    expect(fence(db, "SELECT name FROM sqlite_master", reach("maintenance"))).toEqual({ ok: true });
    expect(fence(db, "SELECT name FROM pragma_table_list()", reach("maintenance"))).toEqual({ ok: true });
  });

  it("refuses KOS's tables outside Maintenance, reads included, and says where to go instead", () => {
    const read = fence(db, "SELECT * FROM conversations", reach("books"));
    expect(read.ok).toBe(false);
    expect(read.reason).toMatch(/conversations: that table is KOS's own/);
    expect(read.reason).toMatch(/chats.handoff/);
    expect(read.reason).toMatch(/cron.list/);
    expect(fence(db, "INSERT INTO pending_messages (conversation_id, text) VALUES ('x', 'y')", reach(undefined)).ok).toBe(false);
  });

  it("lets Maintenance read and write everything, except the trust tables, which nobody writes", () => {
    expect(fence(db, "SELECT * FROM conversations", reach("maintenance")).ok).toBe(true);
    expect(fence(db, "SELECT * FROM books_items JOIN pantry_items", reach("maintenance")).ok).toBe(true);
    expect(fence(db, "DELETE FROM pending_messages WHERE id = 3", reach("maintenance")).ok).toBe(true);
    const trust = fence(db, "UPDATE pending_actions SET status = 'approved'", reach("maintenance"));
    expect(trust.ok).toBe(false);
    expect(trust.reason).toMatch(/trust tables are never written/);
    expect(fence(db, "UPDATE 'pending_actions' SET status = 'approved'", reach("books")).reason).toMatch(/trust tables/);
    expect(fence(db, "SELECT * FROM pending_actions", reach("maintenance")).ok).toBe(true);
    // Read into a project's table, a trust table is only read.
    expect(fence(db, "INSERT INTO books_notes (text) SELECT status FROM pending_actions", reach("maintenance")).ok).toBe(true);
  });

  it("never lets a chat pair a computer by writing its key in", () => {
    const pair = fence(db, "INSERT INTO devices (id, name, platform, public_key, paired_at) VALUES ('dev_x', 'x', 'macos', 'k', 0)", reach("maintenance"));
    expect(pair.ok).toBe(false);
    expect(pair.reason).toMatch(/trust tables/);
    expect(fence(db, "SELECT name FROM devices", reach("books")).ok).toBe(false);
  });

  it("knows a write to KOS's tables from a project's, by the plan", () => {
    expect(writesKernelTable(db, "INSERT INTO books_items (pages, settings) VALUES (?, 'crons')", [1])).toBe(false);
    expect(writesKernelTable(db, "INSERT INTO 'crons' (id) VALUES (1)")).toBe(true);
    expect(writesKernelTable(db, "INSERT INTO memory_facts_fts (value) VALUES ('x')")).toBe(true);
    expect(writesKernelTable(db, "INSERT INTO books_missing (x) VALUES (1)")).toBe(false);
  });

});
