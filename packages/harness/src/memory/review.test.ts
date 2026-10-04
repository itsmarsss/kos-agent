import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { FactsStore } from "./facts.js";
import { CLAIM_LINE, PageLog, importPage, listPages, readPage, writePage } from "./pages.js";
import { ReviewQueue } from "./review.js";

describe("the review queue", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-review-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps one open item per question, and remembers how it was settled", () => {
    let t = 100;
    const q = new ReviewQueue(ws.db, () => t++);
    const a = q.add("contradiction", ["project:pantry/city", "global/city"], "Lisbon vs Toronto");
    const again = q.add("contradiction", ["global/city", "project:pantry/city"], "same thing");
    expect(again.id).toBe(a.id);
    expect(q.pending()).toHaveLength(1);
    expect(q.resolve(a.id, "kept global")).toMatchObject({ resolvedAt: 101, resolution: "kept global" });
    expect(q.pending()).toEqual([]);
    expect(q.add("contradiction", ["global/city", "project:pantry/city"], "later").id).not.toBe(a.id);
    expect(q.recent().map((i) => i.id)).toHaveLength(2);
  });

  it("tells the owner's edit from its own writing, and reads claim lines back as the owner's word", () => {
    const facts = new FactsStore(ws.db);
    const log = new PageLog(ws.db);
    facts.upsert("owner", { key: "city", value: "Montreal", kind: "fact" });
    facts.upsert("owner", { key: "database", value: "sqlite", kind: "fact", scope: "project:pantry" });
    const page = "# Owner\n\n## Home\n- city: Montreal\n- coffee_order: flat white\nSome prose that is not a claim.\n";
    writePage(ws, "profile", page);
    log.record("profile", page);
    expect(log.edited(ws)).toEqual([]);
    // The owner corrects a line and adds one; the dream job's own write is not an edit.
    writePage(ws, "profile", page.replace("Montreal", "Lisbon"));
    writePage(ws, "pantry", "- database: postgres\n");
    expect(log.edited(ws).sort()).toEqual(["pantry", "profile"]);
    const got = importPage(ws, facts, log, "owner", "profile");
    expect(got).toMatchObject({ scope: "global", imported: ["city", "coffee_order"], unchanged: 0 });
    expect(facts.get("owner", "city")).toMatchObject({ value: "Lisbon", trust: "owner", source: "page:profile" });
    expect(facts.history("owner", "city")).toHaveLength(2);
    expect(facts.get("owner", "coffee_order")?.value).toBe("flat white");
    expect(importPage(ws, facts, log, "owner", "pantry")).toMatchObject({ scope: "project:pantry", imported: ["database"] });
    expect(facts.get("owner", "database", "project:pantry")?.value).toBe("postgres");
    expect(log.edited(ws)).toEqual([]);
    // Reading again changes nothing.
    expect(importPage(ws, facts, log, "owner", "profile")).toMatchObject({ imported: [], unchanged: 2 });
    expect(() => importPage(ws, facts, log, "owner", "nothing")).toThrow(/no page/);
    expect(CLAIM_LINE.test("- Favorite tea: oolong")).toBe(false);
  });

  it("writes pages under memory/, inside the jail, and lists them", () => {
    const page = writePage(ws, "profile", "# Owner\n- city: Lisbon");
    expect(page.path).toBe("memory/profile.md");
    expect(readPage(ws, "profile")).toBe("# Owner\n- city: Lisbon\n");
    expect(listPages(ws).map((p) => p.name)).toEqual(["profile"]);
    expect(() => writePage(ws, "../escape", "x")).toThrow(/not a page name/);
    expect(readPage(ws, "nothing")).toBeUndefined();
  });
});
