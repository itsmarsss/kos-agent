import { describe, expect, it } from "vitest";

import { fence, isKernelTable, ownedBy, ownerOf, readsSchema, tablesIn, type Reach } from "./fence.js";

/**
 * The sql tool is for the calling project's tables. KOS's own, another
 * project's and the schema itself are refused outside Maintenance, and the
 * trust tables are written by nobody.
 */
describe("the fence around the tables", () => {
  const existing = ["books_items", "books_notes", "pantry_items", "pantry_2_items", "conversations", "pending_actions", "pending_messages", "memory_facts", "sqlite_master", "tx"];
  const projects = [
    { slug: "books", name: "Books" },
    { slug: "pantry", name: "Pantry" },
    { slug: "pantry_2", name: "Second pantry" },
    { slug: "maintenance", name: "Maintenance" },
  ];
  const reach = (project: string | undefined): Reach => ({ project, projects });

  it("knows KOS's tables by name and by family", () => {
    expect(isKernelTable("conversations")).toBe(true);
    expect(isKernelTable("memory_vec_256_chunks")).toBe(true);
    expect(isKernelTable("sqlite_master")).toBe(true);
    expect(isKernelTable("books_items")).toBe(false);
    expect(isKernelTable("tx")).toBe(false);
  });

  it("finds the tables a statement reaches as whole words", () => {
    expect(tablesIn("SELECT * FROM books_items WHERE conversations_count > 1", existing)).toEqual(["books_items"]);
    expect(tablesIn("insert into Pending_Messages (x) values (1)", existing)).toEqual(["pending_messages"]);
    expect(tablesIn("select name from sqlite_master", existing)).toEqual(["sqlite_master"]);
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
  });

  it("lets a project read and write its own tables, and nothing it does not own", () => {
    expect(fence("SELECT * FROM books_items JOIN books_notes USING (id)", existing, reach("books"))).toEqual({ ok: true });
    expect(fence("INSERT INTO books_items (title) VALUES ('x')", existing, reach("books"))).toEqual({ ok: true });
    expect(fence("SELECT 1", existing, reach("books"))).toEqual({ ok: true });
    const theirs = fence("SELECT * FROM pantry_items", existing, reach("books"));
    expect(theirs.ok).toBe(false);
    expect(theirs.reason).toMatch(/pantry_items is the Pantry project's, not this project's/);
    expect(theirs.reason).toMatch(/reaches only the tables of Books/);
    expect(theirs.reason).toMatch(/@project:maintenance/);
    expect(fence("SELECT * FROM tx", existing, reach("books")).reason).toMatch(/tx belongs to no project/);
    // A longer sibling's table is the sibling's.
    expect(fence("SELECT * FROM pantry_2_items", existing, reach("pantry")).ok).toBe(false);
    expect(fence("SELECT * FROM pantry_items", existing, reach("pantry")).ok).toBe(true);
  });

  it("gives a chat with no project no table at all, and says where to ask", () => {
    const loose = fence("SELECT * FROM books_items", existing, reach(undefined));
    expect(loose.ok).toBe(false);
    expect(loose.reason).toMatch(/books_items is the Books project's/);
    expect(loose.reason).toMatch(/belongs to no project, so no table is its/);
    expect(loose.reason).toMatch(/ask KOS at the root/);
    expect(fence("SELECT 1", existing, reach(undefined))).toEqual({ ok: true });
  });

  it("keeps the schema for Maintenance", () => {
    const listing = fence("SELECT name FROM sqlite_master WHERE type = 'table'", existing, reach("books"));
    expect(listing.ok).toBe(false);
    expect(listing.reason).toMatch(/schema is Maintenance's to read/);
    expect(fence("PRAGMA table_info(books_items)", existing, reach("books")).ok).toBe(false);
    expect(fence("SELECT name FROM sqlite_master", existing, reach("maintenance"))).toEqual({ ok: true });
  });

  it("refuses KOS's tables outside Maintenance, reads included, and says where to go instead", () => {
    const read = fence("SELECT * FROM conversations", existing, reach("books"));
    expect(read.ok).toBe(false);
    expect(read.reason).toMatch(/conversations: that table is KOS's own/);
    expect(read.reason).toMatch(/chats.handoff/);
    expect(read.reason).toMatch(/cron.list/);
    expect(fence("INSERT INTO pending_messages (conversation_id, text) VALUES ('x', 'y')", existing, reach(undefined)).ok).toBe(false);
  });

  it("lets Maintenance read and write everything, except the trust tables, which nobody writes", () => {
    expect(fence("SELECT * FROM conversations", existing, reach("maintenance")).ok).toBe(true);
    expect(fence("SELECT * FROM books_items JOIN pantry_items", existing, reach("maintenance")).ok).toBe(true);
    expect(fence("DELETE FROM pending_messages WHERE id = 3", existing, reach("maintenance")).ok).toBe(true);
    const trust = fence("UPDATE pending_actions SET status = 'approved'", existing, reach("maintenance"));
    expect(trust.ok).toBe(false);
    expect(trust.reason).toMatch(/trust tables are never written/);
    expect(fence("UPDATE pending_actions SET status = 'approved'", existing, reach("books")).reason).toMatch(/trust tables/);
    expect(fence("SELECT * FROM pending_actions", existing, reach("maintenance")).ok).toBe(true);
  });
});
