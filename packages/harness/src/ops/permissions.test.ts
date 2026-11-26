import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { writtenTables } from "../risk/rules.js";
import { BURST_MS, PermissionStore, familyOf, ruleMatches, scopeCovers, scopeOf } from "./permissions.js";

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
    // Writing the whole workspace is never remembered.
    expect(scopeOf("shell.run", { command: "git pull", writes: "workspace" })).toBeUndefined();
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
    // A rule for the workspace's root, kept by an older build, covers nothing.
    expect(scopeCovers("dir:", "dir:anything/at/all")).toBe(false);
    expect(scopeCovers("dir:", "dir:")).toBe(false);
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

  it("keeps a yes for a file at the workspace's root to that file, never the whole workspace", () => {
    const s = store();
    expect(scopeOf("files.rm", { path: "notes.txt" })).toBe("file:notes.txt");
    expect(scopeOf("files.mv", { from: "notes.txt", to: "projects/x.txt" })).toBe("file:notes.txt");
    // The root itself names no rule, so it always asks.
    expect(scopeOf("files.rm", { path: "" })).toBeUndefined();
    expect(scopeOf("files.rm", { path: "/" })).toBeUndefined();
    expect(s.ruleFor("files.rm", { path: "." }, null)).toBeUndefined();
    const rule = s.ruleFor("files.rm", { path: "notes.txt" }, null)!;
    expect(rule.scope).toBe("file:notes.txt");
    s.add(rule);
    expect(s.allows("files.rm", { path: "notes.txt" })).toBe(true);
    expect(s.allows("files.rm", { path: "other.txt" })).toBe(false);
    expect(s.allows("files.rm", { path: "projects/books/old.md" })).toBe(false);
    expect(s.allows("files.rm", { path: "projects" })).toBe(false);
  });

  it("clears out the root rules an older build kept and spells the rest as they are matched, once, on the record", () => {
    const db = new Database(":memory:");
    const s = new PermissionStore(db, () => 1000);
    s.add({ tool: "files.rm", scope: "dir:", project: null });
    const dotted = s.add({ tool: "files.write", scope: "dir:./notes", project: null });
    s.add({ tool: "files.write", scope: "dir:/notes/", project: "site" });
    // Already kept under its proper spelling: the old one is the same rule twice.
    s.add({ tool: "files.mv", scope: "dir:books", project: null });
    s.add({ tool: "files.mv", scope: "dir:/books", project: null });
    s.add({ tool: "http.fetch", scope: "host:a.com", project: null });
    const recorded: { tool: string; args: Record<string, unknown>; result: string }[] = [];
    expect(s.migrateScopes({ record: (e) => recorded.push(e) })).toBe(4);
    expect(s.list().map((r) => [r.tool, r.scope, r.project])).toEqual([
      ["files.write", "dir:notes", null],
      ["files.write", "dir:notes", "site"],
      ["files.mv", "dir:books", null],
      ["http.fetch", "host:a.com", null],
    ]);
    expect(s.list()[0]!.id).toBe(dotted.id);
    expect(recorded.map((e) => [e.tool, e.result])).toEqual([
      ["permissions.migrate", "removed: a rule for the workspace's root matches nothing"],
      ["permissions.migrate", "rescoped to dir:notes"],
      ["permissions.migrate", "rescoped to dir:notes"],
      ["permissions.migrate", "removed: the same rule is kept as dir:books"],
    ]);
    expect(s.allows("files.write", { path: "notes/a.md" })).toBe(true);
    // Run again, nothing is left to do and nothing is recorded.
    expect(s.migrateScopes({ record: (e) => recorded.push(e) })).toBe(0);
    expect(recorded).toHaveLength(4);
  });

  it("says which kept rules can no longer match anything, for Settings to show", () => {
    const s = store();
    s.add({ tool: "skills.commit", scope: null, project: null });
    s.add({ tool: "files.rm", scope: "dir:", project: null });
    s.add({ tool: "files.rm", scope: "dir:notes", project: null });
    expect(s.list().map((r) => r.matches)).toEqual([false, false, true]);
    expect(ruleMatches({ tool: "files.rm", scope: "dir:./x" })).toBe(false);
    expect(ruleMatches({ tool: "files.rm", scope: "file:notes.txt" })).toBe(true);
  });

  it("asks about every skills.commit, after an always as before it", () => {
    const s = store();
    expect(s.ruleFor("skills.commit", { name: "tidy" }, null)).toBeUndefined();
    // A rule an older build kept for it covers nothing.
    s.add({ tool: "skills.commit", scope: null, project: null });
    expect(s.allows("skills.commit", { name: "tidy" })).toBe(false);
    expect(s.allows("skills.commit", { name: "other" })).toBe(false);
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

describe("remembered decisions from a turn's home", () => {
  const school = { home: { folder: "projects/school" }, root: "/ws" };
  const store = (): PermissionStore => new PermissionStore(new Database(":memory:"));

  it("names a file call by where it lands, so two spellings of one place are one scope", () => {
    expect(scopeOf("files.rm", { path: "notes/x.md" }, school)).toBe("dir:projects/school/notes");
    expect(scopeOf("files.rm", { path: "school/notes/x.md" }, school)).toBe("dir:projects/school/notes");
    expect(scopeOf("files.rm", { path: "workspace:notes/x.md" }, school)).toBe("dir:notes");
    expect(scopeOf("files.rm", { path: "workspace:notes/x.md" }, { home: { folder: "" } })).toBe(scopeOf("files.rm", { path: "notes/x.md" }, { home: { folder: "" } }));
  });

  it("keeps a root rule for notes/ off a project's own notes/", () => {
    const rules = store();
    rules.add({ tool: "files.rm", scope: "dir:notes", project: null });
    expect(rules.allows("files.rm", { path: "notes/x.md" }, undefined, { home: { folder: "" } })).toBe(true);
    expect(rules.allows("files.rm", { path: "notes/x.md" }, "school", school)).toBe(false);
    expect(rules.allows("files.rm", { path: "workspace:notes/x.md" }, "school", school)).toBe(true);
  });

  it("never lets a rule made in the project cover a call past its folder, and makes none from one", () => {
    const rules = store();
    // Kept before homes, in the project's words for the root's folder.
    rules.add({ tool: "files.rm", scope: "dir:drafts", project: "school" });
    rules.add({ tool: "export.query", scope: null, project: "school" });
    expect(rules.allows("files.rm", { path: "workspace:drafts/a.md" }, "school", school)).toBe(false);
    // However the folder is spelled.
    rules.add({ tool: "files.write", scope: "dir:projects/other", project: "school" });
    expect(rules.allows("files.write", { path: "workspace:project\u017f/other/a.md" }, "school", school)).toBe(false);
    expect(rules.ruleFor("files.write", { path: "Projects/Other/a.md" }, "school", school)).toBeUndefined();
    expect(rules.allows("export.query", { path: "workspace:out.csv" }, "school", { ...school, reached: true })).toBe(false);
    expect(rules.allows("export.query", { path: "out.csv" }, "school", school)).toBe(true);
    expect(rules.ruleFor("files.write", { path: "projects/resume/cv.md" }, "school", school)).toBeUndefined();
    expect(rules.ruleFor("shell.run", { command: "touch a" }, "school", { ...school, reached: true })).toBeUndefined();
    expect(rules.ruleFor("files.rm", { path: "old/a.md" }, "school", school)).toEqual({ tool: "files.rm", scope: "dir:projects/school/old", project: "school" });
  });
});

describe("a job's consent", () => {
  const post = { to: "discord:channel:42", text: "digest" };

  it("covers that job's runs alone, never a standing ask", () => {
    const rules = new PermissionStore(new Database(":memory:"), () => 2_000);
    rules.add({ tool: "notify", scope: "to:discord:channel:42", project: "school", job: 7 });
    expect(rules.learned("notify", post, { job: { id: 7, since: 1_000 } })).toBe("job");
    expect(rules.learned("notify", post, { job: { id: 8, since: 1_000 } })).toBe(false);
    expect(rules.learned("notify", post, { conversationId: "c1" })).toBe(false);
    // A standing rule is the owner's Always; a job's consent is not one.
    expect(rules.allows("notify", post, "school")).toBe(false);
    expect(rules.learned("notify", { ...post, to: "discord:channel:43" }, { job: { id: 7, since: 1_000 } })).toBe(false);
  });

  it("covers nothing for a job made after it under the same id", () => {
    const rules = new PermissionStore(new Database(":memory:"), () => 2_000);
    rules.add({ tool: "notify", scope: "to:discord:channel:42", project: null, job: 7 });
    expect(rules.learned("notify", post, { job: { id: 7, since: 3_000 } })).toBe(false);
  });

  it("goes with its job", () => {
    const rules = new PermissionStore(new Database(":memory:"));
    rules.add({ tool: "notify", scope: "to:discord:channel:42", project: null, job: 7 });
    rules.add({ tool: "notify", scope: "to:discord:channel:42", project: null });
    expect(rules.forgetJob(7)).toBe(1);
    expect(rules.list().map((r) => r.job)).toEqual([null]);
  });

  it("names a skill run by its skill and its code as stamped, so an edit asks again", () => {
    expect(scopeOf("skills.run", { name: "board", hash: "h1", contained: true })).toBe("skill:board@h1");
    // Code reached outside its folder is not in its hash: nothing is named, so nothing is kept.
    expect(scopeOf("skills.run", { name: "board", hash: "h1" })).toBeUndefined();
    expect(scopeOf("skills.run", { name: "board" })).toBeUndefined();
    expect(scopeOf("skills.run", {})).toBeUndefined();
    const rules = new PermissionStore(new Database(":memory:"), () => 2_000);
    rules.add({ tool: "skills.run", scope: "skill:board@h1", project: null, job: 3 });
    expect(rules.learned("skills.run", { name: "board", hash: "h1", contained: true }, { job: { id: 3, since: 0 } })).toBe("job");
    expect(rules.learned("skills.run", { name: "board", hash: "h2", contained: true }, { job: { id: 3, since: 0 } })).toBe(false);
    expect(rules.learned("skills.run", { name: "other", hash: "h1", contained: true }, { job: { id: 3, since: 0 } })).toBe(false);
    expect(rules.holdBurst("c1", "skills.run", { name: "board", hash: "h1", contained: true })).toBe(true);
    expect(rules.learned("skills.run", { name: "board", hash: "h1", contained: true }, { conversationId: "c1" })).toBe("burst");
    expect(rules.learned("skills.run", { name: "board", hash: "h2", contained: true }, { conversationId: "c1" })).toBe(false);
  });
});

describe("a burst", () => {
  it("holds the yes for the same step in the same chat for fifteen minutes, and not beyond", () => {
    let now = 0;
    const rules = new PermissionStore(new Database(":memory:"), () => now);
    const edit = { path: "skills/scan/run.mjs", text: "x" };
    expect(rules.holdBurst("c1", "files.edit", edit)).toBe(true);
    now = BURST_MS - 1;
    expect(rules.learned("files.edit", edit, { conversationId: "c1" })).toBe("burst");
    // Another chat, another tool or another place asks.
    expect(rules.learned("files.edit", edit, { conversationId: "c2" })).toBe(false);
    expect(rules.learned("files.write", edit, { conversationId: "c1" })).toBe(false);
    expect(rules.learned("files.edit", { path: "projects/x/a.md" }, { conversationId: "c1" })).toBe(false);
    now = BURST_MS;
    expect(rules.learned("files.edit", edit, { conversationId: "c1" })).toBe(false);
    // Nothing of it is kept as a rule.
    expect(rules.list()).toEqual([]);
  });

  it("is never made for a whole tool or a shape it cannot name", () => {
    const rules = new PermissionStore(new Database(":memory:"), () => 0);
    expect(rules.holdBurst("c1", "chats.delete", { id: "x" })).toBe(false);
    expect(rules.holdBurst("c1", "shell.run", { command: "git status && rm -rf ." })).toBe(false);
    expect(rules.learned("chats.delete", { id: "y" }, { conversationId: "c1" })).toBe(false);
  });
});

describe("what a learned yes never names", () => {
  it("never lets a job's rule for the whole tool cover anything", () => {
    const rules = new PermissionStore(new Database(":memory:"), () => 2_000);
    rules.add({ tool: "mcp.git.git_push", scope: null, project: null, job: 4 });
    expect(rules.learned("mcp.git.git_push", { remote: "origin" }, { job: { id: 4, since: 0 } })).toBe(false);
  });

  it("holds no burst past the turn's own folder, and lets none cover a call there", () => {
    const rules = new PermissionStore(new Database(":memory:"), () => 0);
    const edit = { path: "skills/scan/run.mjs", text: "x" };
    expect(rules.holdBurst("c1", "files.edit", edit, { reached: true })).toBe(false);
    expect(rules.holdBurst("c1", "files.edit", edit)).toBe(true);
    expect(rules.learned("files.edit", edit, { conversationId: "c1" }, { reached: true })).toBe(false);
    rules.add({ tool: "files.edit", scope: "dir:skills/scan", project: null, job: 4 });
    expect(rules.learned("files.edit", edit, { job: { id: 4, since: 0 } }, { reached: true })).toBe(false);
  });
});
