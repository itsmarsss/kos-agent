import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { writtenTables } from "../risk/rules.js";
import { PermissionStore, scopeCovers, scopeOf } from "./permissions.js";

describe("naming a call's scope", () => {
  it("names a file call by its directory, a fetch by its host, a write by its table", () => {
    expect(scopeOf("files.rm", { path: "projects/books/notes.md" })).toBe("dir:projects/books");
    expect(scopeOf("files.mv", { from: "a/b/c.txt", to: "x" })).toBe("dir:a/b");
    expect(scopeOf("http.fetch", { url: "https://api.open-meteo.com/v1?x=1" })).toBe("host:api.open-meteo.com");
    expect(scopeOf("sql", { sql: "INSERT INTO books_items (t) VALUES (1)" })).toBe("table:books_items");
    expect(scopeOf("systems.migrate", { spec: { op: "add_column", table: "Books_Items" } })).toBe("table:books_items");
  });

  it("names a shell call by its program, and only when it is one program", () => {
    expect(scopeOf("shell.run", { command: "git status" })).toBe("cmd:git");
    expect(scopeOf("shell.run", { command: "/opt/homebrew/bin/pnpm test" })).toBe("cmd:pnpm");
    // A remembered git must not carry a chained rm with it.
    expect(scopeOf("shell.run", { command: "git status && rm -rf ." })).toBeUndefined();
    expect(scopeOf("shell.run", { command: "cat x | sh" })).toBeUndefined();
    expect(scopeCovers("cmd:git", "cmd:git")).toBe(true);
    expect(scopeCovers("cmd:git", "cmd:rm")).toBe(false);
  });

  it("is tool-wide where there is nothing narrower to name", () => {
    expect(scopeOf("cron.schedule", { name: "x" })).toBeNull();
    expect(scopeOf("sql", { sql: "SELECT 1" })).toBeNull();
    expect(scopeOf("mcp.fs.write", { path: "x" })).toBeNull();
  });

  it("refuses to name a scope it cannot read, so such a call always asks", () => {
    expect(scopeOf("http.fetch", { url: "not a url" })).toBeUndefined();
    expect(scopeOf("sql", { sql: "DELETE FROM" })).toBeUndefined();
  });

  it("reads the tables a statement writes", () => {
    expect(writtenTables("insert into a (x) values (1); update b set y=2; delete from c")).toEqual(["a", "b", "c"]);
    expect(writtenTables('ALTER TABLE "d" ADD COLUMN z')).toEqual(["d"]);
    expect(writtenTables("select * from e")).toEqual([]);
  });

  it("covers a directory's subdirectories and nothing beside them", () => {
    expect(scopeCovers("dir:projects/books", "dir:projects/books")).toBe(true);
    expect(scopeCovers("dir:projects/books", "dir:projects/books/2026")).toBe(true);
    expect(scopeCovers("dir:projects/books", "dir:projects/bookshelf")).toBe(false);
    expect(scopeCovers("dir:", "dir:anything/at/all")).toBe(true);
    expect(scopeCovers("host:a.com", "host:b.com")).toBe(false);
    expect(scopeCovers(null, "host:b.com")).toBe(true);
  });
});

describe("remembered decisions", () => {
  function store() {
    return new PermissionStore(new Database(":memory:"), () => 1000);
  }

  it("stops asking for the same shape, and still asks for a new one", () => {
    const s = store();
    s.add({ tool: "files.rm", scope: "dir:projects/books", project: null });
    expect(s.allows("files.rm", { path: "projects/books/old.md" })).toBe(true);
    expect(s.allows("files.rm", { path: "projects/books/2026/old.md" })).toBe(true);
    expect(s.allows("files.rm", { path: "projects/budget/old.md" })).toBe(false);
    expect(s.allows("files.write", { path: "projects/books/old.md" })).toBe(false);
  });

  it("keeps a project's rule inside that project", () => {
    const s = store();
    s.add({ tool: "sql", scope: "table:books_items", project: "books" });
    const write = { sql: "update books_items set read=1" };
    expect(s.allows("sql", write, "books")).toBe(true);
    expect(s.allows("sql", write, "budget")).toBe(false);
    expect(s.allows("sql", write)).toBe(false);
  });

  it("lets a root rule apply everywhere", () => {
    const s = store();
    s.add({ tool: "http.fetch", scope: "host:api.open-meteo.com", project: null });
    expect(s.allows("http.fetch", { url: "https://api.open-meteo.com/v1" }, "weather")).toBe(true);
    expect(s.allows("http.fetch", { url: "https://evil.example" }, "weather")).toBe(false);
  });

  it("never matches a call whose scope it cannot name", () => {
    const s = store();
    s.add({ tool: "sql", scope: null, project: null });
    // Tool-wide sql would cover reads, but an unreadable write still asks.
    expect(s.allows("sql", { sql: "SELECT 1" })).toBe(true);
    expect(s.allows("sql", { sql: "DELETE FROM" })).toBe(false);
  });

  it("keeps one copy of a rule, and forgets it on revoke", () => {
    const s = store();
    const a = s.add({ tool: "cron.schedule", scope: null, project: null });
    const b = s.add({ tool: "cron.schedule", scope: null, project: null });
    expect(b.id).toBe(a.id);
    expect(s.list()).toHaveLength(1);
    expect(s.revoke(a.id)).toBe(true);
    expect(s.allows("cron.schedule", {})).toBe(false);
  });
});
