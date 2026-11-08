import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "../systems/manifest.js";
import { Migrator } from "../systems/migrate.js";
import { PageStore } from "../systems/pages.js";
import { systemsModule } from "./systems.js";

/**
 * The migrate tool's tier is tool plus arguments: a multi-step build
 * (project_create, migrate, migrate, pages.write) must run end to end without
 * an approval stop, while destructive schema edits still queue.
 */

describe("systems.migrate risk", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  // The chat calling, and the project it belongs to: the chat that makes a project may build it.
  let caller = "c1";
  let callerProject: string | undefined;
  let callerBlob: string | undefined;
  // What the running turn made: the kernel opens it per turn and drops it at the end.
  let made = new Set<string>();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-systems-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    const manifest = new ProjectManifest(ws.db);
    const migrator = new Migrator(ws.db, manifest);
    const pages = new PageStore(ws.db, ws, manifest);
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      manifest,
      migrator,
      pages,
      callerConversation: () => caller,
      callerProject: () => callerProject,
      callerBlob: () => callerBlob,
      turnMade: { note: (slug) => made.add(slug), made: () => [...made] },
      checkArtifact: (id) => Promise.resolve({ text: `checked ${id}` }),
    });
    caller = "c1";
    callerProject = undefined;
    callerBlob = undefined;
    made = new Set();
    await new ModuleLoader(ctx).load([systemsModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const safeOps: Array<{ name: string; spec: unknown }> = [
    {
      name: "create_table",
      spec: {
        op: "create_table",
        table: "tx",
        columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
      },
    },
    {
      name: "add_column",
      spec: { op: "add_column", table: "tx", column: { name: "note", type: "TEXT" } },
    },
    {
      name: "create_index",
      spec: { op: "create_index", table: "tx", columns: ["id"] },
    },
  ];

  for (const c of safeOps) {
    it(`classifies ${c.name} safe`, () => {
      const got = registry.classify("systems.migrate", { project: "budget", spec: c.spec });
      expect(got.tier).toBe("safe");
      expect(got.escalated).toBe(false);
    });
  }

  const riskyOps: Array<{ name: string; spec: unknown }> = [
    { name: "drop_column", spec: { op: "drop_column", table: "tx", column: "note" } },
    {
      name: "rename_column",
      spec: { op: "rename_column", table: "tx", from: "note", to: "memo" },
    },
    { name: "rename_table", spec: { op: "rename_table", from: "tx", to: "ledger" } },
    { name: "an unknown op", spec: { op: "drop_table", table: "tx" } },
    { name: "a malformed spec", spec: "create_table" },
    { name: "a null spec", spec: null },
  ];

  for (const c of riskyOps) {
    it(`escalates ${c.name} to risky`, () => {
      const got = registry.classify("systems.migrate", { project: "budget", spec: c.spec });
      expect(got.tier).toBe("risky");
      expect(got.escalated).toBe(true);
    });
  }

  it("escalates a missing spec", () => {
    expect(registry.classify("systems.migrate", { project: "budget" }).tier).toBe("risky");
  });

  it("runs a project build without an approval stop", async () => {
    const created = await registry.execute("systems.project_create", {
      name: "Budget",
      type: "tracker",
    });
    expect(created.isError).toBe(false);
    const { slug } = JSON.parse(created.content) as { slug: string };

    const steps: unknown[] = [
      {
        op: "create_table",
        table: "tx",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "amount", type: "REAL" },
        ],
      },
      { op: "add_column", table: "tx", column: { name: "category", type: "TEXT" } },
      { op: "create_index", table: "tx", columns: ["category"] },
    ];

    for (const spec of steps) {
      const args = { project: slug, spec };
      expect(registry.classify("systems.migrate", args).tier).toBe("safe");
      const res = await registry.execute("systems.migrate", args);
      expect(res.isError).toBe(false);
    }

    const cols = ws.db.prepare(`SELECT * FROM budget_tx`).all();
    expect(cols).toEqual([]);
  });

  it("lets a project's schema be changed by the turn that made it, its own chats and Maintenance, and no one else", async () => {
    const created = await registry.execute("systems.project_create", { name: "Garden", type: "tracker" });
    const { slug } = JSON.parse(created.content) as { slug: string };
    const args = { project: slug, spec: { op: "create_table", table: "beds", columns: [{ name: "id", type: "INTEGER", primaryKey: true }] } };
    expect((await registry.execute("systems.migrate", args)).isError).toBe(false);
    // The turn is over: the same chat, a turn later, has no reach left.
    made = new Set();
    expect((await registry.execute("systems.migrate", { ...args, spec: { ...args.spec, table: "rows" } })).content).toMatch(/@project:garden/);
    caller = "c2";
    const loose = await registry.execute("systems.migrate", args);
    expect(loose.isError).toBe(true);
    expect(loose.content).toMatch(/This chat belongs to no project, so Garden's tables are not its to change.*@project:garden/);
    callerProject = "pantry";
    expect((await registry.execute("systems.migrate", args)).content).toMatch(/This chat is pantry's, so Garden's tables/);
    callerProject = slug;
    expect((await registry.execute("systems.migrate", { ...args, spec: { ...args.spec, table: "plots" } })).isError).toBe(false);
    callerProject = "maintenance";
    expect((await registry.execute("systems.migrate", { ...args, spec: { op: "add_column", table: "beds", column: { name: "note", type: "TEXT" } } })).isError).toBe(false);
  });

  it("still rejects a malformed spec at execution", async () => {
    const res = await registry.execute("systems.migrate", {
      project: "budget",
      spec: { table: "tx" },
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/op/);
  });

  it("writes an HTML page through artifacts.write, keeps the older spec form, and rolls back", async () => {
    const created = await registry.execute("systems.project_create", { name: "Budget", type: "tracker" });
    const { slug } = JSON.parse(created.content) as { slug: string };
    const html = await registry.execute("artifacts.write", { project: slug, id: "home", title: "Home", html: "<h1>Hi</h1>" });
    expect(html.isError).toBe(false);
    expect(JSON.parse(html.content)).toMatchObject({ kind: "html" });
    const spec = await registry.execute("artifacts.write", { project: slug, spec: { id: "old", title: "Old", widgets: [{ type: "markdown", content: "x" }] } });
    expect(JSON.parse(spec.content)).toMatchObject({ kind: "spec" });
    await registry.execute("artifacts.write", { project: slug, id: "home", title: "Home", html: "<h1>Two</h1>" });
    const history = JSON.parse((await registry.execute("artifacts.history", { id: "home" })).content) as { version: number }[];
    expect(history.map((v) => v.version)).toEqual([1, 2]);
    await registry.execute("artifacts.rollback", { id: "home", version: 1 });
    const got = JSON.parse((await registry.execute("artifacts.get", { id: "home" })).content) as { page: { html: string } };
    expect(got.page.html).toBe("<h1>Hi</h1>");
  });

  it("keeps a project's artifacts to its own chats, and a root chat to the workspace's", async () => {
    const a = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    const b = JSON.parse((await registry.execute("systems.project_create", { name: "Pantry", type: "tracker" })).content) as { slug: string };
    expect((await registry.execute("artifacts.write", { project: b.slug, id: "shelf", title: "Shelf", html: "<h1>Shelf</h1>" })).isError).toBe(false);
    expect((await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" })).isError).toBe(false);
    made = new Set();

    // A project-A chat neither checks nor reads project B's.
    callerProject = a.slug;
    for (const tool of ["artifacts.check", "artifacts.get", "artifacts.history"]) {
      const got = await registry.execute(tool, { id: "shelf" });
      expect(got.isError).toBe(true);
      expect(got.content).toMatch(/This chat is Garden's, so Pantry's artifacts are not its to read.*@project:pantry/);
    }
    expect((await registry.execute("artifacts.check", { id: "memo" })).content).toBe("checked memo");

    // The root chat: a project's artifact is the project's, to read or to write.
    callerProject = undefined;
    const check = await registry.execute("artifacts.check", { id: "shelf" });
    expect(check.isError).toBe(true);
    expect(check.content).toMatch(/This chat belongs to no project, so Pantry's artifacts are not its to read.*chats.handoff to @project:pantry/);
    const write = await registry.execute("artifacts.write", { project: a.slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" });
    expect(write.isError).toBe(true);
    expect(write.content).toMatch(/This chat belongs to no project, so Garden's artifacts are not its to change.*@project:garden/);
    expect((await registry.execute("artifacts.get", { id: "memo" })).isError).toBe(false);
    expect((await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Two</h1>" })).isError).toBe(false);

    // Its own chat reaches it.
    callerProject = b.slug;
    expect((await registry.execute("artifacts.check", { id: "shelf" })).content).toBe("checked shelf");
  });

  it("gives a blob's turn its own artifacts, kept with its files, and fences them both ways", async () => {
    const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    expect((await registry.execute("artifacts.write", { project: slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" })).isError).toBe(false);
    expect((await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" })).isError).toBe(false);
    made = new Set();

    // From the blob's own thread, an artifact with no project is the blob's own, in its folder.
    callerBlob = "noter";
    const own = JSON.parse((await registry.execute("artifacts.write", { id: "notes", title: "Notes", html: "<h1>Notes</h1>" })).content) as { blob?: string; projectSlug: string | null; path: string };
    expect(own).toMatchObject({ blob: "noter", projectSlug: null, path: "blobs/noter/artifacts/notes.html" });
    expect(existsSync(join(root, "blobs/noter/artifacts/notes.html"))).toBe(true);
    for (const tool of ["artifacts.get", "artifacts.history", "artifacts.check"]) expect((await registry.execute(tool, { id: "notes" })).isError, tool).toBe(false);
    expect((await registry.execute("artifacts.rollback", { id: "notes", version: 1 })).isError).toBe(false);
    // It has no tables, as a workspace artifact has none.
    const reaching = await registry.execute("artifacts.write", { id: "board", title: "Board", html: "<h1>B</h1>", headline: { label: "N", query: "SELECT 1" } });
    expect(reaching.content).toMatch(/a blob's artifact \(noter's\) belongs to no project/);
    // A blob's turn reaches no project's artifact, to read or to write, and lists only its own and the workspace's.
    for (const tool of ["artifacts.get", "artifacts.history", "artifacts.check"]) {
      const got = await registry.execute(tool, { id: "beds" });
      expect(got.isError).toBe(true);
      expect(got.content).toMatch(/This chat is the blob noter's, so Garden's artifacts are not its to read/);
    }
    expect((await registry.execute("artifacts.write", { project: slug, id: "beds2", title: "B", html: "<h1>B</h1>" })).isError).toBe(true);
    expect((await registry.execute("artifacts.write", { id: "beds", title: "Mine now", html: "<h1>B</h1>" })).content).toMatch(/Garden's artifacts are not its to change/);
    // The page the refused write named stays as it was, where it was.
    const beds = (): string => readFileSync(join(root, `projects/${slug}/pages/beds.html`), "utf8");
    expect(beds()).toContain("<h1>Beds</h1>");
    const listed = (JSON.parse((await registry.execute("artifacts.list", {})).content) as { id: string }[]).map((r) => r.id).sort();
    expect(listed).toEqual(["memo", "notes"]);

    // Another blob reaches none of noter's.
    callerBlob = "roster";
    const theirs = await registry.execute("artifacts.get", { id: "notes" });
    expect(theirs.isError).toBe(true);
    expect(theirs.content).toMatch(/This chat is the blob roster's, so the blob noter's artifacts are not its to read.*blobs.dispatch to noter/);
    expect((await registry.execute("artifacts.write", { id: "notes", title: "Taken", html: "<h1>x</h1>" })).isError).toBe(true);
    const notes = (): string => readFileSync(join(root, "blobs/noter/artifacts/notes.html"), "utf8");
    expect(notes()).toContain("<h1>Notes</h1>");
    expect(existsSync(join(root, "blobs/roster/artifacts/notes.html"))).toBe(false);
    expect((JSON.parse((await registry.execute("artifacts.list", {})).content) as { id: string }[]).map((r) => r.id)).not.toContain("notes");

    // Nor does a project's chat.
    callerBlob = undefined;
    callerProject = slug;
    expect((await registry.execute("artifacts.get", { id: "notes" })).content).toMatch(/This chat is Garden's, so the blob noter's artifacts are not its to read/);
    expect((await registry.execute("artifacts.rollback", { id: "notes", version: 1 })).isError).toBe(true);
    expect((await registry.execute("artifacts.write", { project: slug, id: "notes", title: "Ours", html: "<h1>y</h1>" })).content).toMatch(/the blob noter's artifacts are not its to change/);
    expect((await registry.execute("artifacts.write", { id: "notes", title: "Ours", html: "<h1>y</h1>" })).isError).toBe(true);
    expect(notes()).toContain("<h1>Notes</h1>");
    expect(existsSync(join(root, `projects/${slug}/pages/notes.html`))).toBe(false);
    expect((JSON.parse((await registry.execute("artifacts.list", {})).content) as { id: string }[]).map((r) => r.id)).not.toContain("notes");

    // KOS at the root reaches a blob's, as it reaches a blob's files.
    callerProject = undefined;
    const kept = JSON.parse((await registry.execute("artifacts.get", { id: "notes" })).content) as { record: { title: string; blob?: string } };
    expect(kept.record).toMatchObject({ title: "Notes", blob: "noter" });
    expect((JSON.parse((await registry.execute("artifacts.list", {})).content) as { id: string }[]).map((r) => r.id)).toContain("notes");
    expect(beds()).toContain("<h1>Beds</h1>");
    // Maintenance reaches it too, as it reaches every project's.
    callerProject = "maintenance";
    expect((await registry.execute("artifacts.history", { id: "notes" })).isError).toBe(false);
  });

  it("keeps a rewritten artifact in its project unless told to move it", async () => {
    const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    await registry.execute("artifacts.write", { project: slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" });
    const rewrite = await registry.execute("artifacts.write", { id: "beds", title: "Beds", html: "<h1>Beds two</h1>" });
    expect(JSON.parse(rewrite.content)).toMatchObject({ projectSlug: slug, path: "projects/garden/pages/beds.html" });
    expect(JSON.parse((await registry.execute("artifacts.history", { id: "beds" })).content)).toHaveLength(2);
    const ids = async (project: string): Promise<string[]> => (JSON.parse((await registry.execute("artifacts.list", { project })).content) as { id: string }[]).map((r) => r.id);
    expect(await ids("@workspace")).toEqual([]);
    const moved = await registry.execute("artifacts.write", { project: "@workspace", id: "beds", title: "Beds", html: "<h1>Beds three</h1>" });
    expect(JSON.parse(moved.content)).toMatchObject({ projectSlug: null, path: "artifacts/beds.html" });
    expect(await ids("@workspace")).toEqual(["beds"]);
    expect(JSON.parse((await registry.execute("artifacts.history", { id: "beds" })).content)).toHaveLength(3);
  });

  it("tells the model the check is not available where KOS has no Chrome", async () => {
    const bare = new ToolRegistry();
    const manifest = new ProjectManifest(ws.db);
    const ctx = toolRegistryContext(bare, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), manifest, migrator: new Migrator(ws.db, manifest), pages: new PageStore(ws.db, ws, manifest) });
    await new ModuleLoader(ctx).load([systemsModule]);
    const told = (name: string): string => bare.defs().find((d) => d.name === name)?.description ?? "";
    expect(told("artifacts.write")).toMatch(/artifacts.check is not available/);
    expect(told("artifacts.write")).not.toMatch(/check once with artifacts.check/);
    expect(told("artifacts.check")).toMatch(/^Not available on this KOS/);
    expect((await bare.execute("artifacts.guide", { kind: "doc" })).content).toMatch(/artifacts.check is not available here/);
    expect(registry.defs().find((d) => d.name === "artifacts.write")?.description).toMatch(/check once with artifacts.check/);
  });
});
