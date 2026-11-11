import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RoleStore } from "../agents/roles.js";
import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { Migrator } from "./migrate.js";
import { ArtifactTrashed, PageStore } from "./pages.js";

/** The owner's management of artifacts: rename, duplicate, move, and a trash that keeps them. */
describe("PageStore management", () => {
  let root: string;
  let ws: Workspace;
  let pages: PageStore;
  let t: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-manage-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Budget", type: "tracker" });
    manifest.createProject({ name: "Diary", type: "notes" });
    new Migrator(ws.db, manifest).migrate("budget", { op: "create_table", table: "tx", columns: [{ name: "id", type: "INTEGER", primaryKey: true }, { name: "amount", type: "REAL" }] });
    t = 1000;
    pages = new PageStore(ws.db, ws, manifest, () => (t += 1000));
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("renames an artifact under the same id, the rename kept as a version", () => {
    pages.writeHtml("budget", { id: "plan", kind: "doc", title: "Plan", description: "The plan.", html: "<article data-doc><h1>Plan</h1></article>" });
    const renamed = pages.rename("plan", { title: "  Spring plan ", description: "What happens in spring." });
    expect(renamed).toMatchObject({ id: "plan", title: "Spring plan", description: "What happens in spring.", projectSlug: "budget", artifactKind: "doc" });
    expect(pages.history("plan").map((v) => v.title)).toEqual(["Plan", "Spring plan"]);
    // A title alone keeps the description, and an empty description clears it.
    expect(pages.rename("plan", { title: "Plan B" }).description).toBe("What happens in spring.");
    expect(pages.rename("plan", { description: "" }).description).toBeUndefined();
    expect(() => pages.rename("plan", { title: " " })).toThrow(/title is required/);
    expect(() => pages.rename("plan", {})).toThrow(/new title or description/);
    expect(() => pages.rename("nope", { title: "X" })).toThrow(/not found/);
  });

  it("renames an older widget page's title, which has no description", () => {
    pages.write("budget", { id: "old", title: "Old", widgets: [{ type: "markdown", content: "hi" }] });
    expect(pages.rename("old", { title: "Older" }).title).toBe("Older");
    expect(() => pages.rename("old", { description: "x" })).toThrow(/no description/);
  });

  it("duplicates beside it, the same owner's, under a free id, with a history of its own", () => {
    pages.writeHtml("budget", { id: "spend", title: "Spend", html: "<p>one</p>", capabilities: { writes: [{ table: "budget_tx", columns: ["amount"] }] } });
    pages.writeHtml("budget", { id: "spend", title: "Spend", html: "<p>two</p>", capabilities: { writes: [{ table: "budget_tx", columns: ["amount"] }] } });
    const copy = pages.duplicate("spend");
    expect(copy).toMatchObject({ id: "spend-copy", title: "Spend copy", projectSlug: "budget", path: "projects/budget/pages/spend-copy.html" });
    const got = pages.get("spend-copy");
    expect(got?.kind === "html" && got.page.html).toBe("<p>two</p>");
    expect(got?.kind === "html" && got.page.capabilities?.writes?.[0]?.table).toBe("budget_tx");
    expect(pages.history("spend-copy").map((v) => v.version)).toEqual([1]);
    expect(pages.history("spend")).toHaveLength(2);
    // The next copy takes the next free id, in any case.
    pages.writeHtml(null, { id: "Spend-Copy-2", title: "Taken", html: "<p>" });
    expect(pages.duplicate("spend").id).toBe("spend-copy-3");
  });

  it("moves an artifact to another owner with its id, versions and captures", () => {
    const roles = new RoleStore(ws, pages.blobIds);
    roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    const noter = { blob: "noter", id: roles.identity("noter")! };
    pages.writeHtml(null, { id: "memo", title: "Memo", html: "<p>one</p>" });
    pages.writeHtml(null, { id: "memo", title: "Memo", html: "<p>two</p>" });
    mkdirSync(pages.capturesDir("memo"), { recursive: true });
    writeFileSync(join(pages.capturesDir("memo"), "desktop-light.small.jpg"), "x");

    expect(pages.move("memo", "diary")).toMatchObject({ id: "memo", projectSlug: "diary", path: "projects/diary/pages/memo.html" });
    expect(existsSync(join(root, "artifacts/memo.html"))).toBe(false);
    expect(existsSync(join(root, "projects/diary/pages/.captures/memo/desktop-light.small.jpg"))).toBe(true);
    expect(pages.history("memo").map((v) => v.version)).toEqual([1, 2, 3]);

    expect(pages.move("memo", noter)).toMatchObject({ blob: "noter", path: "blobs/noter/artifacts/memo.html" });
    expect(pages.move("memo", null)).toMatchObject({ projectSlug: null, path: "artifacts/memo.html" });
    expect(pages.history("memo")).toHaveLength(5);
    expect(() => pages.move("memo", null)).toThrow(/already the workspace's/);
  });

  it("refuses a move that would leave an artifact reaching tables its new owner does not have", () => {
    pages.writeHtml("budget", { id: "spend", title: "Spend", html: "<p>", capabilities: { writes: [{ table: "budget_tx", columns: ["amount"] }] } });
    expect(() => pages.move("spend", "diary")).toThrow(/"budget_tx" is not a table of project "diary"/);
    expect(() => pages.move("spend", null)).toThrow(/belongs to no project/);
    expect(pages.record("spend")?.projectSlug).toBe("budget");
    pages.write("budget", { id: "old", title: "Old", widgets: [{ type: "markdown", content: "hi" }] });
    expect(() => pages.move("old", null)).toThrow(/needs a project/);
  });

  it("moves nothing to a removed blob, and copies nothing into one, though its work can be moved out", () => {
    const roles = new RoleStore(ws, pages.blobIds);
    roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    const noter = { blob: "noter", id: roles.identity("noter")! };
    pages.writeHtml(noter, { id: "n", title: "Notes", html: "<p>n</p>" });
    pages.writeHtml(null, { id: "w", title: "W", html: "<p>w</p>" });
    roles.remove("noter");
    expect(() => pages.move("w", noter)).toThrow(/was removed/);
    expect(() => pages.duplicate("n")).toThrow(/was removed/);
    expect(pages.move("n", "diary")).toMatchObject({ projectSlug: "diary" });
    expect(pages.record("n")?.blob).toBeUndefined();
  });

  it("refuses an id another artifact holds in another case, a trashed one too, before anything is written", () => {
    pages.writeHtml("diary", { id: "notes", title: "Notes", html: "<p>diary</p>" });
    expect(() => pages.writeHtml(null, { id: "Notes", title: "Mine", html: "<p>mine</p>" })).toThrow(/is notes in another case/);
    // One from before the rule, in the workspace beside it: a move into the diary would take the diary's file on a disk that ignores case.
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts/Notes.html"), "<p>old</p>");
    ws.db.prepare(`INSERT INTO pages (id, project_slug, title, path, updated_at, kind, meta) VALUES ('Notes', '', 'Old', 'artifacts/Notes.html', 1, 'html', '{}')`).run();
    expect(() => pages.move("Notes", "diary")).toThrow(/in another case/);
    expect(readFileSync(join(root, "projects/diary/pages/notes.html"), "utf8")).toBe("<p>diary</p>");
    expect(pages.record("Notes")?.projectSlug).toBeNull();
    // Rewritten where it is, it is let be: the two already live apart.
    expect(pages.rename("Notes", { title: "Older" }).title).toBe("Older");
    // In the trash, the id is still taken.
    pages.writeHtml("diary", { id: "plan", title: "Plan", html: "<p>" });
    pages.trash("plan");
    expect(() => pages.writeHtml(null, { id: "PLAN", title: "Plan", html: "<p>" })).toThrow(/in another case/);
  });

  it("leaves an artifact whole where it was when its move fails part way", () => {
    pages.writeHtml(null, { id: "memo", title: "Memo", html: "<p>one</p>" });
    mkdirSync(pages.capturesDir("memo"), { recursive: true });
    writeFileSync(join(pages.capturesDir("memo"), "desktop-light.small.jpg"), "x");
    // The captures cannot go: their new folder takes nothing.
    const locked = join(root, "projects/diary/pages/.captures");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o555);
    try {
      expect(() => pages.move("memo", "diary")).toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(pages.record("memo")).toMatchObject({ projectSlug: null, path: "artifacts/memo.html" });
    expect(existsSync(join(root, "artifacts/.history/memo/1.json"))).toBe(true);
    expect(existsSync(join(root, "artifacts/.captures/memo/desktop-light.small.jpg"))).toBe(true);
    expect(existsSync(join(root, "projects/diary/pages/.history/memo"))).toBe(false);
    expect(existsSync(join(root, "projects/diary/pages/memo.html"))).toBe(false);
    expect(pages.history("memo")).toHaveLength(1);
    // Once it can, it goes, whole.
    expect(pages.move("memo", "diary").projectSlug).toBe("diary");
    expect(existsSync(join(root, "projects/diary/pages/.captures/memo/desktop-light.small.jpg"))).toBe(true);
  });

  it("trashes an artifact out of every list, keeps it as it is, and restores it where it was", () => {
    pages.writeHtml("budget", { id: "spend", title: "Spend", html: "<p>" });
    pages.writeHtml(null, { id: "memo", title: "Memo", html: "<p>" });
    const trashed = pages.trash("spend");
    expect(trashed.trashedAt).toBeGreaterThan(0);
    expect(pages.list().map((r) => r.id)).toEqual(["memo"]);
    expect(pages.list("budget")).toEqual([]);
    expect(pages.list(undefined, { trashed: true }).map((r) => r.id)).toEqual(["spend"]);
    expect(pages.list("budget", { trashed: true }).map((r) => r.id)).toEqual(["spend"]);
    // Still there to show, with its file and versions.
    expect(pages.get("spend")?.record.trashedAt).toBe(trashed.trashedAt);
    expect(existsSync(join(root, "projects/budget/pages/spend.html"))).toBe(true);
    expect(() => pages.trash("spend")).toThrow(/already in the trash/);

    const restored = pages.restore("spend");
    expect(restored.trashedAt).toBeUndefined();
    expect(restored.projectSlug).toBe("budget");
    expect(pages.list("budget").map((r) => r.id)).toEqual(["spend"]);
    expect(() => pages.restore("spend")).toThrow(/not in the trash/);
  });

  it("changes nothing in the trash: no write, edit, rollback, rename, copy or move until it is restored", () => {
    pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: "<article data-doc><h1>B</h1><p>one</p></article>" });
    pages.trash("brief");
    const base = pages.record("brief")!.updatedAt;
    expect(() => pages.writeHtml("budget", { id: "brief", title: "Brief", html: "<p>" })).toThrow(ArtifactTrashed);
    expect(() => pages.applyEdit("brief", { doc: "<h1>B</h1><p>two</p>" }, base)).toThrow(/in the trash/);
    expect(() => pages.rollback("brief", 1)).toThrow(/in the trash/);
    expect(() => pages.rename("brief", { title: "X" })).toThrow(/in the trash/);
    expect(() => pages.duplicate("brief")).toThrow(/in the trash/);
    expect(() => pages.move("brief", null)).toThrow(/in the trash/);
    // A new artifact cannot take its id either.
    expect(() => pages.writeHtml(null, { id: "brief", title: "Other", html: "<p>" })).toThrow(/in the trash/);
    expect(pages.history("brief")).toHaveLength(1);
    // Deleted for good, it goes with its versions.
    expect(pages.remove("brief")).toBe(true);
    expect(existsSync(join(root, "projects/budget/pages/.history/brief"))).toBe(false);
    expect(pages.record("brief")).toBeUndefined();
  });

  it("adds the trash column to a pages table from before it, every row out of the trash, and works after", () => {
    const old = mkdtempSync(join(tmpdir(), "kos-manage-old-"));
    try {
      const w = Workspace.open(old);
      w.db.exec(`CREATE TABLE pages (id TEXT PRIMARY KEY, project_slug TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'spec', meta TEXT, blob TEXT, blob_id TEXT)`);
      mkdirSync(join(old, "artifacts"), { recursive: true });
      writeFileSync(join(old, "artifacts/m.html"), "<p>m</p>");
      w.db.prepare(`INSERT INTO pages VALUES ('m', '', 'M', 'artifacts/m.html', 2, 'html', '{}', NULL, NULL)`).run();
      const store = new PageStore(w.db, w, new ProjectManifest(w.db));
      const cols = (w.db.prepare(`PRAGMA table_info(pages)`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("trashed_at");
      expect(store.list().map((r) => [r.id, r.trashedAt])).toEqual([["m", undefined]]);
      // Opening it again changes nothing, and the migrated table takes the trash.
      const again = new PageStore(w.db, w, new ProjectManifest(w.db));
      expect(again.trash("m").trashedAt).toBeGreaterThan(0);
      expect(again.list()).toEqual([]);
      expect(again.rename.bind(again, "m", { title: "N" })).toThrow(/in the trash/);
      expect(again.restore("m").title).toBe("M");
      expect(again.rename("m", { title: "N" }).title).toBe("N");
      w.close();
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
});
