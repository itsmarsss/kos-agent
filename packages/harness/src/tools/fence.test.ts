import { describe, expect, it } from "vitest";

import { fence, isKernelTable, namesKernelTable, tablesIn } from "./fence.js";

/**
 * The sql tool is for a project's tables. KOS's own are refused outside
 * Maintenance, and the trust tables are written by nobody.
 */
describe("the fence around KOS's own tables", () => {
  const existing = ["books_items", "books_notes", "conversations", "pending_actions", "pending_messages", "memory_facts", "sqlite_master", "tx"];

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

  it("refuses KOS's tables outside Maintenance, reads included, and says where to go instead", () => {
    const read = fence("SELECT * FROM conversations", existing, "books");
    expect(read.ok).toBe(false);
    expect(read.reason).toMatch(/conversations: that table is KOS's own/);
    expect(read.reason).toMatch(/chats.handoff/);
    expect(fence("INSERT INTO pending_messages (conversation_id, text) VALUES ('x', 'y')", existing, undefined).ok).toBe(false);
    expect(fence("SELECT * FROM books_items", existing, "books")).toEqual({ ok: true, hideKernelRows: false });
    expect(fence("SELECT 1", existing, undefined)).toEqual({ ok: true, hideKernelRows: false });
  });

  it("lets Maintenance read and write them, except the trust tables, which nobody writes", () => {
    expect(fence("SELECT * FROM conversations", existing, "maintenance").ok).toBe(true);
    expect(fence("DELETE FROM pending_messages WHERE id = 3", existing, "maintenance").ok).toBe(true);
    const trust = fence("UPDATE pending_actions SET status = 'approved'", existing, "maintenance");
    expect(trust.ok).toBe(false);
    expect(trust.reason).toMatch(/trust tables are never written/);
    expect(fence("UPDATE pending_actions SET status = 'approved'", existing, "books").reason).toMatch(/trust tables/);
    expect(fence("SELECT * FROM pending_actions", existing, "maintenance").ok).toBe(true);
  });

  it("lets a project list the schema, with KOS's rows to be dropped", () => {
    expect(fence("SELECT name FROM sqlite_master WHERE type = 'table'", existing, "books")).toEqual({ ok: true, hideKernelRows: true });
    expect(fence("SELECT name FROM sqlite_master", existing, "maintenance").hideKernelRows).toBe(false);
    expect(namesKernelTable({ name: "conversations" })).toBe(true);
    expect(namesKernelTable({ type: "index", tbl_name: "memory_facts" })).toBe(true);
    expect(namesKernelTable({ name: "books_items" })).toBe(false);
    expect(namesKernelTable("x")).toBe(false);
  });
});
