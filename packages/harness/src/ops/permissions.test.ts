import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { writtenTables } from "../risk/rules.js";
import { PermissionStore, familyOf, scopeCovers, scopeOf } from "./permissions.js";

describe("naming a call's scope", () => {
  it("names a file call by its directory, a fetch by its host, a write by its table", () => {
    expect(scopeOf("files.rm", { path: "projects/books/notes.md" })).toBe("dir:projects/books");
    expect(scopeOf("files.mv", { from: "a/b/c.txt", to: "x" })).toBe("dir:a/b");
    expect(scopeOf("http.fetch", { url: "https://api.open-meteo.com/v1?x=1" })).toBe("host:api.open-meteo.com");
    expect(scopeOf("sql", { sql: "INSERT INTO books_items (t) VALUES (1)" })).toBe("table:books_items");
    expect(scopeOf("systems.migrate", { spec: { op: "add_column", table: "Books_Items" } })).toBe("table:books_items");
  });

  it("names a hand-off by its target, as the owner named it", () => {
    // A post is remembered for its destination alone; a word to the owner never asks.
    expect(scopeOf("notify", { to: "discord:channel:123", text: "x" })).toBe("to:discord:channel:123");
    expect(scopeOf("notify", { to: "channel:123", text: "x" })).toBe("to:channel:123");
    expect(scopeOf("notify", { to: "user:9", text: "x" })).toBe("to:user:9");
    expect(scopeOf("notify", { text: "x" })).toBeNull();
    expect(scopeOf("notify", { to: 42, text: "x" })).toBeUndefined();
    expect(scopeOf("chats.handoff", { to: "@project:books", brief: "x" })).toBe("to:project:books");
    expect(scopeOf("chats.handoff", { to: "@chat:[abc:owner]", brief: "x" })).toBe("to:chat:abc:owner");
    expect(scopeOf("chats.handoff", { to: "books", brief: "x" })).toBe("to:books");
    expect(scopeOf("chats.handoff", { brief: "x" })).toBeUndefined();
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

describe("trusting a site for the browser", () => {
  const context = { browser: { prefix: "browser.", site: "example.com", strict: ["browser.eval"] } };

  it("names a browser action by the site its tab is on, as one family", () => {
    expect(scopeOf("browser.act", { steps: [{ click: "@e5" }] }, context)).toBe("site:example.com");
    expect(familyOf("browser.act", context)).toBe("browser.*");
    expect(scopeOf("browser.act", { steps: [{ click: "@e5" }] }, { browser: { prefix: "browser." } })).toBeUndefined();
    expect(scopeOf("browser.eval", { code: "x" }, context)).toBeUndefined();
    expect(scopeOf("files.write", { path: "a/b.txt" }, context)).toBe("dir:a");
    expect(familyOf("files.write", context)).toBe("files.write");
  });

  it("remembers one yes for every action on that site, and nowhere else", () => {
    const store = new PermissionStore(new Database(":memory:"), () => 1);
    const rule = store.ruleFor("browser.act", { steps: [{ click: "@e5" }] }, null, context);
    expect(rule).toEqual({ tool: "browser.*", scope: "site:example.com", project: null });
    store.add(rule!);
    expect(store.allows("browser.act", { steps: [{ fill: { target: "@e2", text: "x" } }] }, undefined, context)).toBe(true);
    expect(store.allows("browser.eval", { code: "x" }, undefined, context)).toBe(false);
    expect(store.allows("browser.act", { steps: [] }, undefined, { browser: { ...context.browser, site: "other.example" } })).toBe(false);
    expect(store.allows("browser.act", { steps: [] }, undefined, { browser: { prefix: "browser." } })).toBe(false);
  });

  it("keeps the owner's own Chrome apart: a site trusted in KOS's is asked about again there", () => {
    const store = new PermissionStore(new Database(":memory:"), () => 1);
    store.add(store.ruleFor("browser.act", { steps: [] }, null, context)!);
    const yours = { browser: { ...context.browser, yours: true } };
    expect(scopeOf("browser.act", { steps: [] }, yours)).toBe("your-chrome:example.com");
    expect(store.allows("browser.act", { steps: [] }, undefined, yours)).toBe(false);
    store.add(store.ruleFor("browser.act", { steps: [] }, null, yours)!);
    expect(store.allows("browser.act", { steps: [] }, undefined, yours)).toBe(true);
  });
});
