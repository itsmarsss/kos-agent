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
import type { CheckAsk } from "../systems/artifactcheck.js";
import { RoleStore } from "../agents/roles.js";
import { attendance, guested, ownership, turn } from "../kernel/caller.js";
import { filesModule } from "./files.js";
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
  // The blob whose thread is calling, by name; its id is the living blob's, as the kernel reads it.
  let callerBlob: string | undefined;
  let roles: RoleStore;
  // What the running turn made: the kernel opens it per turn and drops it at the end.
  let made = new Set<string>();
  // The registry's own execute, run as no turn in particular.
  let execute: ToolRegistry["execute"];
  // The artifacts' store, for what only the owner does: the trash.
  let store: PageStore;
  // How each check was asked for, in order.
  let asks: CheckAsk[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-systems-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    // A call here is the owner's own turn's, as one from the dashboard is, unless a test says otherwise.
    execute = registry.execute.bind(registry);
    registry.execute = (name, input) => ownership.run(true, () => execute(name, input));
    const manifest = new ProjectManifest(ws.db);
    const migrator = new Migrator(ws.db, manifest);
    const pages = new PageStore(ws.db, ws, manifest);
    store = pages;
    roles = new RoleStore(ws, pages.blobIds);
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      manifest,
      migrator,
      pages,
      callerConversation: () => caller,
      callerProject: () => callerProject,
      callerBlob: () => {
        const id = callerBlob ? roles.identity(callerBlob) : undefined;
        return callerBlob && id ? { name: callerBlob, id } : undefined;
      },
      turnMade: { note: (slug) => made.add(slug), made: () => [...made] },
      checkArtifact: (id, ask) => {
        asks.push(ask ?? {});
        return Promise.resolve({ text: `checked ${id}${ask?.final ? " after the fix" : ""}` });
      },
    });
    caller = "c1";
    callerProject = undefined;
    callerBlob = undefined;
    made = new Set();
    asks = [];
    await new ModuleLoader(ctx).load([systemsModule, filesModule]);
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

    for (const name of ["noter", "roster"]) roles.write({ name, description: name, brief: "Work.", memory: "own" });
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

  it("refuses a write whose spec names another owner's artifact under an id of its own", async () => {
    const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    const other = JSON.parse((await registry.execute("systems.project_create", { name: "Shed", type: "tracker" })).content) as { slug: string };
    await registry.execute("artifacts.write", { project: other.slug, id: "tools", title: "Tools", html: "<h1>Tools</h1>" });
    roles.write({ name: "noter", description: "Notes", brief: "Work.", memory: "own" });
    callerBlob = "noter";
    await registry.execute("artifacts.write", { id: "notes", title: "Notes", html: "<h1>Notes</h1>" });
    callerBlob = undefined;
    made = new Set();
    callerProject = slug;
    const spec = (id: string) => ({ id, title: "Taken", widgets: [{ type: "markdown", content: "x" }] });
    for (const target of ["notes", "tools"]) {
      const res = await registry.execute("artifacts.write", { project: slug, id: "mine", spec: spec(target) });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/id "mine" and spec.id "\w+" differ/);
      // Named by the spec alone, the fence sees it and the store holds it too.
      expect((await registry.execute("artifacts.write", { project: slug, spec: spec(target) })).isError).toBe(true);
    }
    expect(readFileSync(join(root, "blobs/noter/artifacts/notes.html"), "utf8")).toContain("<h1>Notes</h1>");
    expect(readFileSync(join(root, `projects/${other.slug}/pages/tools.html`), "utf8")).toContain("<h1>Tools</h1>");
    expect(existsSync(join(root, `projects/${slug}/pages/notes.json`))).toBe(false);
    expect(existsSync(join(root, `projects/${slug}/pages/tools.json`))).toBe(false);
    // The same id twice is one artifact, and writes.
    expect((await registry.execute("artifacts.write", { project: slug, id: "mine", spec: spec("mine") })).isError).toBe(false);
  });

  it("keeps a removed blob's artifacts from a blob made again under its name, and from KOS's changes", async () => {
    roles.write({ name: "noter", description: "Notes", brief: "Work.", memory: "own" });
    callerBlob = "noter";
    await registry.execute("artifacts.write", { id: "notes", title: "Notes", html: "<h1>Notes</h1>" });
    roles.remove("noter");
    // Its old thread is no blob's own any more: as a root chat it may read, not change.
    expect((await registry.execute("artifacts.get", { id: "notes" })).isError).toBe(false);
    expect((await registry.execute("artifacts.rollback", { id: "notes", version: 1 })).content).toMatch(/The blob noter that made it was removed.*not its to change/);
    // Made again, from the root or a project's chat, it is a new owner.
    for (const project of [undefined, "garden"]) {
      if (project) await registry.execute("systems.project_create", { name: "Garden", type: "tracker" });
      callerProject = project;
      callerBlob = undefined;
      roles.remove("noter");
      roles.write({ name: "noter", description: "Notes again", brief: "Work.", memory: "own" });
      callerProject = undefined;
      callerBlob = "noter";
      for (const tool of ["artifacts.get", "artifacts.history", "artifacts.check"]) expect((await registry.execute(tool, { id: "notes" })).isError, tool).toBe(true);
      expect((await registry.execute("artifacts.write", { id: "notes", title: "Mine", html: "<h1>x</h1>" })).isError).toBe(true);
      expect((await registry.execute("artifacts.rollback", { id: "notes", version: 1 })).isError).toBe(true);
      expect((JSON.parse((await registry.execute("artifacts.list", {})).content) as { id: string }[]).map((r) => r.id)).not.toContain("notes");
    }
    expect(readFileSync(join(root, "blobs/noter/artifacts/notes.html"), "utf8")).toContain("<h1>Notes</h1>");
  });

  it("opens a blob's artifacts at the root only to the owner's own turn, not a schedule's or a guest's", async () => {
    roles.write({ name: "noter", description: "Notes", brief: "Work.", memory: "own" });
    callerBlob = "noter";
    await registry.execute("artifacts.write", { id: "notes", title: "Notes", html: "<h1>Notes</h1>" });
    callerBlob = undefined;
    expect((await registry.execute("artifacts.get", { id: "notes" })).isError).toBe(false);
    // A turn the owner did not start (a schedule's run, a guest in a channel) is not the owner's own chat.
    const unattended = await attendance.run(false, () => registry.execute("artifacts.get", { id: "notes" }));
    expect(unattended.isError).toBe(true);
    // Nor a turn whose door never said it was the owner's: work passed on, a caller that forgot.
    const unsaid = await ownership.run(false, () => execute("artifacts.get", { id: "notes" }));
    expect(unsaid.isError).toBe(true);
    caller = "cron:7";
    expect((await registry.execute("artifacts.get", { id: "notes" })).isError).toBe(true);
  });

  it("holds an artifact's file, versions and captures to the same fence through files.*", async () => {
    const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    roles.write({ name: "noter", description: "Notes", brief: "Work.", memory: "own" });
    callerBlob = "noter";
    await registry.execute("artifacts.write", { id: "notes", title: "Notes", html: "<h1>Notes</h1>" });
    expect((await registry.execute("files.read", { path: "blobs/noter/artifacts/notes.html" })).content).toContain("<h1>Notes</h1>");
    callerBlob = undefined;
    made = new Set();
    callerProject = slug;
    for (const path of ["blobs/noter/artifacts/notes.html", "blobs/noter/artifacts/.history/notes/1.json"]) {
      const read = await registry.execute("files.read", { path });
      expect(read.isError, path).toBe(true);
      expect(read.content).toMatch(/part of the artifact notes; This chat is Garden's, so the blob noter's artifacts are not this chat's to read/);
    }
    for (const [tool, args] of [
      ["files.write", { path: "blobs/noter/artifacts/notes.html", content: "<h1>x</h1>" }],
      ["files.edit", { path: "blobs/noter/artifacts/notes.html", find: "Notes", replace: "x" }],
      ["files.rm", { path: "blobs/noter/artifacts/notes.html" }],
      ["files.cp", { from: "blobs/noter/artifacts/notes.html", to: "scratch/n.html" }],
    ] as const) expect((await registry.execute(tool, args)).isError, tool).toBe(true);
    expect(readFileSync(join(root, "blobs/noter/artifacts/notes.html"), "utf8")).toContain("<h1>Notes</h1>");
    // Its other files are files: the blob's brief is not an artifact.
    expect((await registry.execute("files.read", { path: "blobs/noter/blob.md" })).isError).toBe(false);
  });

  it("holds the fence through a change of case, which opens the same file on a case-insensitive disk", async () => {
    const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    const other = (JSON.parse((await registry.execute("systems.project_create", { name: "Vault", type: "tracker" })).content) as { slug: string }).slug;
    await registry.execute("artifacts.write", { project: other, id: "keys", title: "Keys", html: "<h1>Keys</h1>" });
    roles.write({ name: "noter", description: "Notes", brief: "Work.", memory: "own" });
    callerBlob = "noter";
    await registry.execute("artifacts.write", { id: "notes", title: "Notes", html: "<h1>Notes</h1>" });
    callerBlob = undefined;
    made = new Set();
    callerProject = slug;
    // Refused by the path's own words, whether or not this disk would open it.
    for (const path of [
      "Blobs/noter/artifacts/notes.html",
      "blobs/NOTER/Artifacts/NOTES.HTML",
      "blobs/noter/artifacts/.History/Notes/1.json",
      `PROJECTS/${other}/Pages/Keys.html`,
      `projects/${other}/pages/.CAPTURES/keys`,
    ]) {
      for (const [tool, args] of [
        ["files.read", { path }],
        ["files.write", { path, content: "x" }],
        ["files.rm", { path }],
      ] as const) {
        const res = await registry.execute(tool, args);
        expect(res.isError, `${tool} ${path}`).toBe(true);
        expect(res.content, `${tool} ${path}`).toMatch(/part of the artifact (notes|keys)/);
      }
    }
    for (const path of ["Blobs/Noter", `Projects/${other.toUpperCase()}/PAGES`]) {
      const res = await registry.execute("files.rm", { path });
      expect(res.isError, path).toBe(true);
      expect(res.content).toMatch(/holds the artifact/);
    }
    for (const path of [".KOS/results/x.json", "./.Kos/x"]) {
      const res = await registry.execute("files.write", { path, content: "x" });
      expect(res.isError, path).toBe(true);
      expect(res.content).toMatch(/KOS's own state/);
    }
    expect(readFileSync(join(root, "blobs/noter/artifacts/notes.html"), "utf8")).toContain("<h1>Notes</h1>");
  });

  it("refuses a folder taken whole when it holds an artifact the chat may not reach, by the rows under it", async () => {
    const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    await registry.execute("artifacts.write", { project: slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" });
    made = new Set();
    for (const name of ["noter", "roster"]) {
      roles.write({ name, description: name, brief: "Work.", memory: "own" });
      callerBlob = name;
      await registry.execute("artifacts.write", { id: `${name}-doc`, title: name, html: `<h1>${name}</h1>` });
    }
    callerBlob = undefined;
    const pages = `projects/${slug}/pages`;
    const refused = async (tool: string, args: Record<string, unknown>): Promise<string> => {
      const res = await registry.execute(tool, args);
      expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      return res.content;
    };
    const allowed = async (tool: string, args: Record<string, unknown>): Promise<void> => {
      const res = await registry.execute(tool, args);
      expect(res.isError, `${tool} ${JSON.stringify(args)}: ${res.content}`).toBe(false);
    };

    // A project's chat: not a blob's folder, its artifacts or their versions, nor the whole workspace.
    callerProject = slug;
    expect(await refused("files.rm", { path: "blobs/noter" })).toMatch(/blobs\/noter holds the artifact noter-doc; This chat is Garden's, so the blob noter's artifacts are not this chat's to change/);
    await refused("files.rm", { path: "blobs/noter/artifacts" });
    await refused("files.rm", { path: "blobs/noter/artifacts/.history" });
    await refused("files.mv", { from: "blobs/noter", to: "scratch/noter" });
    await refused("files.cp", { from: "blobs/noter/artifacts", to: "scratch/x" });
    await refused("files.rm", { path: "." });
    // A blob's own turn: not a project's pages, nor another blob's folder.
    callerProject = undefined;
    callerBlob = "noter";
    await refused("files.rm", { path: pages });
    await refused("files.mv", { from: "blobs/roster", to: "scratch/roster" });
    // The root, the owner's own chat: a blob's folder, but not a project's pages.
    callerBlob = undefined;
    await refused("files.rm", { path: pages });
    await refused("files.rm", { path: "projects" });
    expect(existsSync(join(root, "blobs/noter/artifacts/noter-doc.html"))).toBe(true);
    expect(existsSync(join(root, `${pages}/beds.html`))).toBe(true);
    // Nor its own: an artifact is taken away from the trash, by the owner, never by files.*.
    expect(await refused("files.mv", { from: "blobs/roster", to: "scratch/roster" })).toMatch(/blobs\/roster holds the artifact roster-doc, which files.\* does not take away: .*trash/);
    callerBlob = "noter";
    await refused("files.rm", { path: "blobs/noter/artifacts/.history" });
    callerBlob = undefined;
    callerProject = slug;
    await refused("files.rm", { path: pages });
    // A copy out is a read, and its own to make.
    await allowed("files.cp", { from: `${pages}/beds.html`, to: "scratch/beds.html" });
    // A folder that holds no artifact is a folder.
    await allowed("files.mkdir", { path: "notes/old" });
    await allowed("files.rm", { path: "notes" });
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

  it("renames and copies what the chat may change, keeping the id, and never another owner's", async () => {
    const a = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    const b = JSON.parse((await registry.execute("systems.project_create", { name: "Pantry", type: "tracker" })).content) as { slug: string };
    await registry.execute("artifacts.write", { project: a.slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" });
    await registry.execute("artifacts.write", { project: b.slug, id: "shelf", title: "Shelf", html: "<h1>Shelf</h1>" });
    made = new Set();
    callerProject = a.slug;
    const renamed = JSON.parse((await registry.execute("artifacts.rename", { id: "beds", title: "Raised beds", description: "Where each bed is." })).content) as { id: string; title: string; description: string };
    expect(renamed).toMatchObject({ id: "beds", title: "Raised beds", description: "Where each bed is." });
    const copy = JSON.parse((await registry.execute("artifacts.duplicate", { id: "beds" })).content) as { id: string; title: string; projectSlug: string };
    expect(copy).toMatchObject({ id: "beds-copy", title: "Raised beds copy", projectSlug: a.slug });
    expect(JSON.parse((await registry.execute("artifacts.history", { id: "beds-copy" })).content)).toHaveLength(1);
    // Pantry's is Pantry's.
    for (const tool of ["artifacts.rename", "artifacts.duplicate"]) {
      const got = await registry.execute(tool, { id: "shelf", title: "Mine" });
      expect(got.isError, tool).toBe(true);
      expect(got.content).toMatch(/This chat is Garden's, so Pantry's artifacts are not its to change/);
    }
    expect(store.record("shelf")?.title).toBe("Shelf");
    expect((await registry.execute("artifacts.rename", { id: "nope", title: "X" })).content).toMatch(/not found/);
  });

  it("moves an artifact only from and to where the chat reaches, and never into a removed blob", async () => {
    const a = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    const b = JSON.parse((await registry.execute("systems.project_create", { name: "Pantry", type: "tracker" })).content) as { slug: string };
    await registry.execute("artifacts.write", { project: a.slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" });
    await registry.execute("artifacts.write", { project: b.slug, id: "shelf", title: "Shelf", html: "<h1>Shelf</h1>" });
    await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" });
    for (const name of ["noter", "gone"]) roles.write({ name, description: name, brief: "Work.", memory: "own" });
    made = new Set();

    // A project's chat: not into another project, not out of one, not into a blob.
    callerProject = a.slug;
    const across = await registry.execute("artifacts.move", { id: "beds", project: b.slug });
    expect(across.isError).toBe(true);
    expect(across.content).toMatch(/This chat is Garden's, so Pantry's artifacts are not its to change/);
    expect((await registry.execute("artifacts.move", { id: "shelf", project: a.slug })).content).toMatch(/Pantry's artifacts are not its to change/);
    expect((await registry.execute("artifacts.move", { id: "beds", blob: "noter" })).content).toMatch(/the blob noter's artifacts are not its to change/);
    expect(store.record("beds")?.projectSlug).toBe(a.slug);
    // Its own to the workspace and back, with its id and versions.
    expect(JSON.parse((await registry.execute("artifacts.move", { id: "beds", project: "@workspace" })).content)).toMatchObject({ id: "beds", projectSlug: null });
    expect(JSON.parse((await registry.execute("artifacts.move", { id: "memo", project: a.slug })).content)).toMatchObject({ projectSlug: a.slug });
    expect(JSON.parse((await registry.execute("artifacts.history", { id: "beds" })).content)).toHaveLength(2);
    expect((await registry.execute("artifacts.move", { id: "beds" })).content).toMatch(/say where it goes/);
    expect((await registry.execute("artifacts.move", { id: "beds", project: "nowhere" })).content).toMatch(/unknown project/);

    // The owner's own turn at the root: the workspace and a blob, never a project's.
    callerProject = undefined;
    expect(JSON.parse((await registry.execute("artifacts.move", { id: "beds", blob: "noter" })).content)).toMatchObject({ blob: "noter" });
    expect((await registry.execute("artifacts.move", { id: "beds", project: b.slug })).content).toMatch(/belongs to no project, so Pantry's artifacts are not its to change/);
    expect((await registry.execute("artifacts.move", { id: "beds", blob: "nobody" })).content).toMatch(/no blob is called nobody/);
    roles.remove("gone");
    expect((await registry.execute("artifacts.move", { id: "beds", blob: "gone" })).content).toMatch(/no blob is called gone/);

    // Maintenance reaches across.
    callerProject = "maintenance";
    expect(JSON.parse((await registry.execute("artifacts.move", { id: "shelf", project: a.slug })).content)).toMatchObject({ projectSlug: a.slug });
  });

  it("gives KOS no delete, leaves the trash out of its lists unless asked, and changes nothing in it", async () => {
    const names = registry.defs().map((d) => d.name).filter((n) => n.startsWith("artifacts."));
    expect(names).toEqual(expect.arrayContaining(["artifacts.rename", "artifacts.duplicate", "artifacts.move"]));
    expect(names.filter((n) => /delete|trash|remove|purge/.test(n))).toEqual([]);
    await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" });
    await registry.execute("artifacts.write", { id: "old", title: "Old", html: "<h1>Old</h1>" });
    store.trash("old");
    const ids = async (input: Record<string, unknown>): Promise<string[]> => (JSON.parse((await registry.execute("artifacts.list", input)).content) as { id: string }[]).map((r) => r.id);
    expect(await ids({})).toEqual(["memo"]);
    expect(await ids({ trashed: true })).toEqual(["old"]);
    for (const [tool, input] of [
      ["artifacts.write", { id: "old", title: "Old", html: "<h1>Back</h1>" }],
      ["artifacts.rename", { id: "old", title: "New" }],
      ["artifacts.duplicate", { id: "old" }],
      ["artifacts.move", { id: "old", project: "@workspace" }],
      ["artifacts.rollback", { id: "old", version: 1 }],
    ] as const) {
      const got = await registry.execute(tool, input);
      expect(got.isError, tool).toBe(true);
      expect(got.content, tool).toMatch(/in the trash/);
    }
    expect(store.record("old")?.title).toBe("Old");
  });

  it("lets nothing change a trashed artifact's file, versions or captures, nor check it, though it can still be read", async () => {
    await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" });
    store.trash("memo");
    expect((await registry.execute("files.read", { path: "artifacts/memo.html" })).content).toContain("<h1>Memo</h1>");
    for (const [tool, args] of [
      ["files.write", { path: "artifacts/memo.html", content: "<h1>x</h1>" }],
      ["files.edit", { path: "artifacts/memo.html", find: "Memo", replace: "x" }],
      ["files.rm", { path: "artifacts/memo.html" }],
      ["files.rm", { path: "artifacts/.history/memo/1.json" }],
      ["files.mv", { from: "artifacts/memo.html", to: "scratch/memo.html" }],
      ["files.rm", { path: "artifacts" }],
    ] as const) {
      const got = await registry.execute(tool, args);
      expect(got.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(got.content).toMatch(/the owner put in the trash/);
    }
    expect(readFileSync(join(root, "artifacts/memo.html"), "utf8")).toBe("<h1>Memo</h1>");
    expect(existsSync(join(root, "artifacts/.history/memo/1.json"))).toBe(true);
    const check = await registry.execute("artifacts.check", { id: "memo" });
    expect(check.isError).toBe(true);
    expect(check.content).toMatch(/in the trash.*nothing to check/);
    // Restored, it is a file like any artifact's again.
    store.restore("memo");
    expect((await registry.execute("artifacts.check", { id: "memo" })).content).toBe("checked memo");
  });

  it("refuses every management call that a guest's words started", async () => {
    const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
    await registry.execute("artifacts.write", { project: slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" });
    made = new Set();
    callerProject = slug;
    const guest = { project: slug, chat: `project:${slug}` };
    for (const [tool, input] of [
      ["artifacts.rename", { id: "beds", title: "Theirs" }],
      ["artifacts.duplicate", { id: "beds" }],
      ["artifacts.move", { id: "beds", project: "@workspace" }],
    ] as const) {
      const got = await guested.run(guest, () => registry.execute(tool, input));
      expect(got.isError, tool).toBe(true);
      expect(got.content, tool).toMatch(/a guest's words started this work/);
    }
    expect(store.record("beds")).toMatchObject({ title: "Beds", projectSlug: slug });
  });

  describe("artifacts.patch", () => {
    const patch = async (id: string, edits: unknown[]): Promise<{ isError: boolean; content: string }> => registry.execute("artifacts.patch", { id, edits });
    const file = (path: string): string => readFileSync(join(root, path), "utf8");
    const versions = async (id: string): Promise<number> => (JSON.parse((await registry.execute("artifacts.history", { id })).content) as unknown[]).length;

    it("changes one piece, keeps a version, checks it, and answers in a line rather than the document", async () => {
      const rows = Array.from({ length: 600 }, (_, i) => `<tr><td>Item ${i}</td><td>${i * 3}</td></tr>`).join("\n");
      const html = `<h1>Ledger</h1>\n<table>\n${rows}\n</table>`;
      expect(html.length).toBeGreaterThan(20_000);
      await registry.execute("artifacts.write", { id: "ledger", title: "Ledger", html });
      const got = await patch("ledger", [{ find: "<h1>Ledger</h1>", replace: "<h1>October ledger</h1>" }, { find: "<td>Item 7</td>", replace: "<td>Rent</td>" }]);
      expect(got.isError, got.content).toBe(false);
      expect(got.content.length).toBeLessThan(400);
      const [line, check] = got.content.split("\n\n");
      expect(JSON.parse(line!)).toEqual({ id: "ledger", title: "Ledger", artifactKind: "page", projectSlug: null, updatedAt: store.record("ledger")!.updatedAt, version: 2, edits: 2, replaced: 2, lines: { removed: 2, added: 2, of: 603 }, bytes: { before: html.length, after: html.length + 6 } });
      expect(check).toBe("checked ledger");
      // Its sizes are what is stored: a <\/ counts as the </ it is saved as.
      const escaped = JSON.parse((await patch("ledger", [{ find: "<h1>October ledger</h1>", replace: "<h1>Ledger<\\/h1>" }])).content.split("\n\n")[0]!) as { bytes: { after: number } };
      expect(escaped.bytes.after).toBe(Buffer.byteLength(file("artifacts/ledger.html")));
      await patch("ledger", [{ find: "<h1>Ledger</h1>", replace: "<h1>October ledger</h1>" }]);
      expect(file("artifacts/ledger.html")).toBe(html.replace("<h1>Ledger</h1>", "<h1>October ledger</h1>").replace("<td>Item 7</td>", "<td>Rent</td>"));
      expect(await versions("ledger")).toBe(4);
    });

    it("checks once and once after the fix in a turn, and then no more, so nothing loops", async () => {
      await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1><p>a</p>" });
      const inTurn = (id: string, work: () => Promise<{ content: string }>): Promise<string> => turn.run(id, work).then((r) => r.content);
      expect(await inTurn("t1", () => registry.execute("artifacts.check", { id: "memo" }))).toBe("checked memo");
      expect((await inTurn("t1", () => patch("memo", [{ find: "<p>a</p>", replace: "<p>b</p>" }]))).split("\n\n")[1]).toBe("checked memo after the fix");
      for (const call of [() => patch("memo", [{ find: "<p>b</p>", replace: "<p>c</p>" }]), () => registry.execute("artifacts.check", { id: "memo" })]) {
        expect(await inTurn("t1", call)).toMatch(/Not checked again: it has had its check and the check after the fix in this turn/);
      }
      expect(file("artifacts/memo.html")).toBe("<h1>Memo</h1><p>c</p>");
      // Outside a turn (a schedule's fixed actions) nothing is counted, and nothing carries over.
      for (let i = 0; i < 4; i++) expect((await registry.execute("artifacts.check", { id: "memo" })).content).toBe("checked memo");
      // A patch that comes first in its turn asks for the fix; the next is the check after it.
      expect((await inTurn("t2", () => patch("memo", [{ find: "<p>c</p>", replace: "<p>d</p>" }]))).split("\n\n")[1]).toBe("checked memo");
      expect((await inTurn("t2", () => patch("memo", [{ find: "<p>d</p>", replace: "<p>e</p>" }]))).split("\n\n")[1]).toBe("checked memo after the fix");
    });

    it("lets a request of several changes run to its end: every patch applies, and none says to stop", async () => {
      await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1><table><tr><td>a</td></tr></table><p>x</p>" });
      const steps = [
        [{ find: "<h1>Memo</h1>", replace: "<h1>Notes</h1>" }],
        [{ find: "<td>a</td>", replace: "<td>a</td><td>b</td>" }],
        [{ find: "<p>x</p>", replace: '<p class="accent">x</p>' }],
      ];
      const said: string[] = [];
      for (const edits of steps) said.push(await turn.run("t1", () => patch("memo", edits)).then((r) => r.content));
      expect(file("artifacts/memo.html")).toBe('<h1>Notes</h1><table><tr><td>a</td><td>b</td></tr></table><p class="accent">x</p>');
      expect(asks).toEqual([{ final: false, patch: true }, { final: true, patch: true }]);
      expect(said[2]).toMatch(/Saved\. Not checked again: .* Make any other change the owner asked for, then finish without another check\./);
      for (const words of said) expect(words).not.toMatch(/Finish here|Do not patch, write|tell the owner in a line what is left, and finish/);
    });

    it("leaves the artifact as it was when any edit fails, saying which and why", async () => {
      await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1><p>Draft</p><p>Draft</p>" });
      const missing = await patch("memo", [{ find: "<h1>Memo</h1>", replace: "<h1>Note</h1>" }, { find: "<h2>Gone</h2>", replace: "x" }]);
      expect(missing.content).toMatch(/edit 2: find does not occur in the stored HTML/);
      expect((await patch("memo", [{ find: "Draft", replace: "Final" }])).content).toMatch(/find occurs 2 times/);
      expect((await patch("memo", [{ find: "Memo", replace: "Memo" }])).content).toMatch(/nothing changed/);
      // A </ written as <\/ is stored as </, so it changes nothing either.
      expect((await patch("memo", [{ find: "</h1>", replace: "<\\/h1>" }])).content).toMatch(/nothing changed/);
      expect(file("artifacts/memo.html")).toBe("<h1>Memo</h1><p>Draft</p><p>Draft</p>");
      expect(await versions("memo")).toBe(1);
      expect((await patch("memo", [{ find: "Draft", replace: "Final", all: true }])).isError).toBe(false);
      expect(file("artifacts/memo.html")).toBe("<h1>Memo</h1><p>Final</p><p>Final</p>");
    });

    it("is the only way to change part of a document: files.* gives an artifact's document no new content", async () => {
      await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" });
      await registry.execute("files.write", { path: "scratch/x.html", content: "<iframe></iframe>" });
      await registry.execute("artifacts.check", { id: "memo" });
      for (const path of ["artifacts/memo.html", "artifacts/Memo.html", "artifacts/.history/memo/1.json", "artifacts/.history/memo/9.json", "artifacts/.captures/memo/desktop-light.jpg"]) {
        for (const [tool, args] of [
          ["files.write", { path, content: "<iframe></iframe>" }],
          ["files.edit", { path, find: "Memo", replace: "x" }],
          ["files.cp", { from: "scratch/x.html", to: path }],
          ["files.mv", { from: "scratch/x.html", to: path }],
        ] as const) {
          const got = await registry.execute(tool, args);
          expect(got.content, `${tool} ${path}`).toMatch(/is part of the artifact memo, which files.\* does not change: change part of it with artifacts.patch/);
        }
        for (const [tool, args] of [
          ["files.rm", { path }],
          ["files.mv", { from: path, to: "scratch/gone" }],
        ] as const) {
          const got = await registry.execute(tool, args);
          expect(got.content, `${tool} ${path}`).toMatch(/is part of the artifact memo, which files.\* does not take away: KOS never deletes an artifact; the owner puts one in the trash/);
        }
      }
      for (const path of ["artifacts", "artifacts/.history", "artifacts/.history/memo", "artifacts/.captures/memo"]) {
        expect((await registry.execute("files.rm", { path })).content, path).toMatch(/(holds|is part of) the artifact memo, which files.\* does not take away/);
      }
      expect(file("artifacts/memo.html")).toBe("<h1>Memo</h1>");
      expect(existsSync(join(root, "artifacts/.history/memo/1.json"))).toBe(true);
      expect(existsSync(join(root, "scratch/x.html"))).toBe(true);
      expect((await registry.execute("files.read", { path: "artifacts/memo.html" })).isError).toBe(false);
    });

    it("checks the bytes it stores: a <\\/ end tag is repaired before any check reads it", async () => {
      const offPage = '<title>Memo<\\/title><a href="&#104;ttps://example.com/x">x</a><title>t</title><h1>Memo</h1>';
      const handler = '<h1>Memo</h1><script>const s = "<\\/script><a href=&#104;ttps://example.com/x>x</a>";</script>';
      for (const html of [offPage, handler]) {
        const got = await registry.execute("artifacts.write", { id: "leak", title: "Leak", html });
        expect(got.isError, html).toBe(true);
        expect(got.content).toMatch(/invalid artifact/);
      }
      const doc = '<article data-doc><h1>Brief</h1><p>Text</p></article>';
      await registry.execute("artifacts.write", { id: "brief", kind: "doc", title: "Brief", html: doc });
      const inArticle = await registry.execute("artifacts.write", { id: "brief", kind: "doc", title: "Brief", html: '<article data-doc><h1>Brief</h1><title>a<\\/title><img src=x onerror=alert(1)><title>b</title></article>' });
      expect(inArticle.content).toMatch(/invalid artifact/);
      await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<title>Memo</title><h1>Memo</h1>" });
      for (const replace of ['<title>Memo<\\/title><a href="&#104;ttps://example.com/x">x</a><title>t</title>', '<script>const s = "<\\/script><a href=&#104;ttps://example.com/x>x</a>";</script><title>Memo</title>']) {
        const got = await patch("memo", [{ find: "<title>Memo</title>", replace }]);
        expect(got.content, replace).toMatch(/invalid artifact/);
      }
      expect((await patch("brief", [{ find: "<p>Text</p>", replace: "<p><title>a<\\/title><img src=x onerror=alert(1)><title>b</title></p>" }])).content).toMatch(/invalid artifact/);
      expect(file("artifacts/memo.html")).toBe("<title>Memo</title><h1>Memo</h1>");
      expect(file("artifacts/brief.html")).toBe(doc);
      expect(store.record("leak")).toBeUndefined();
      // A plain one is still repaired and stored repaired.
      await registry.execute("artifacts.write", { id: "ok", title: "Ok", html: '<h1>Ok</h1><script>const s = "x";<\\/script>' });
      expect(file("artifacts/ok.html")).toBe('<h1>Ok</h1><script>const s = "x";</script>');
    });

    it("holds the result to every check a write holds", async () => {
      await registry.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" });
      const leaving = await patch("memo", [{ find: "<h1>Memo</h1>", replace: '<h1>Memo</h1><iframe src="https://example.com"></iframe>' }]);
      expect(leaving.content).toMatch(/invalid artifact: a page cannot leave its frame/);
      expect(file("artifacts/memo.html")).toBe("<h1>Memo</h1>");
    });

    it("patches a doc's stored article, held to what the owner's editor can save", async () => {
      const html = '<article data-doc><h1>Brief</h1><h2 id="plan">Plan</h2><p>Ship in May.</p></article>';
      await registry.execute("artifacts.write", { id: "brief", kind: "doc", title: "Brief", html });
      expect((await patch("brief", [{ find: "Ship in May.", replace: "Ship in June." }])).isError).toBe(false);
      expect(file("artifacts/brief.html")).toBe(html.replace("May", "June"));
      expect((await patch("brief", [{ id: "plan", html: '<h2 id="plan">Plan, revised</h2>' }])).isError).toBe(false);
      expect((await patch("brief", [{ find: "<p>", replace: "<p><script>x()</script>" }])).content).toMatch(/the text inside <article data-doc> is what the owner edits/);
      expect((await patch("brief", [{ find: "<h1>Brief</h1>", replace: '<h1>Brief</h1><nav data-kos-gen="toc"></nav>' }])).content).toMatch(/data-kos-gen/);
      expect(file("artifacts/brief.html")).toBe('<article data-doc><h1>Brief</h1><h2 id="plan">Plan, revised</h2><p>Ship in June.</p></article>');
      expect(store.record("brief")?.artifactKind).toBe("doc");
    });

    it("reaches only what the chat may change, never in the trash, and never from a guest's words", async () => {
      const { slug } = JSON.parse((await registry.execute("systems.project_create", { name: "Garden", type: "tracker" })).content) as { slug: string };
      const other = (JSON.parse((await registry.execute("systems.project_create", { name: "Pantry", type: "tracker" })).content) as { slug: string }).slug;
      await registry.execute("artifacts.write", { project: slug, id: "beds", title: "Beds", html: "<h1>Beds</h1>" });
      await registry.execute("artifacts.write", { project: other, id: "shelf", title: "Shelf", html: "<h1>Shelf</h1>" });
      await registry.execute("artifacts.write", { id: "old", title: "Old", html: "<h1>Old</h1>" });
      store.trash("old");
      made = new Set();
      callerProject = slug;
      const edit = [{ find: "<h1>", replace: "<h1 class=x>" }];
      expect((await patch("shelf", edit)).content).toMatch(/This chat is Garden's, so Pantry's artifacts are not its to change/);
      expect((await patch("old", edit)).content).toMatch(/in the trash/);
      expect((await patch("nope", edit)).content).toMatch(/artifact not found: nope/);
      const guest = await guested.run({ project: slug, chat: `project:${slug}` }, () => patch("beds", edit));
      expect(guest.content).toMatch(/a guest's words started this work/);
      expect([file(`projects/${slug}/pages/beds.html`), file(`projects/${other}/pages/shelf.html`), file("artifacts/old.html")]).toEqual(["<h1>Beds</h1>", "<h1>Shelf</h1>", "<h1>Old</h1>"]);
      expect((await patch("beds", edit)).isError).toBe(false);
      expect(registry.classify("artifacts.patch", { id: "beds", edits: edit }).tier).toBe(registry.classify("artifacts.write", { id: "beds" }).tier);
    });
  });

  it("tells the model the check is not available where KOS has no Chrome", async () => {
    const bare = new ToolRegistry();
    const manifest = new ProjectManifest(ws.db);
    const ctx = toolRegistryContext(bare, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), manifest, migrator: new Migrator(ws.db, manifest), pages: new PageStore(ws.db, ws, manifest) });
    await new ModuleLoader(ctx).load([systemsModule, filesModule]);
    const told = (name: string): string => bare.defs().find((d) => d.name === name)?.description ?? "";
    expect(told("artifacts.write")).toMatch(/artifacts.check is not available/);
    expect(told("artifacts.write")).not.toMatch(/check once with artifacts.check/);
    expect(told("artifacts.check")).toMatch(/^Not available on this KOS/);
    expect(told("artifacts.patch")).not.toMatch(/artifacts.check|findings/);
    await bare.execute("artifacts.write", { id: "memo", title: "Memo", html: "<h1>Memo</h1>" });
    const patched = await bare.execute("artifacts.patch", { id: "memo", edits: [{ find: "Memo</h1>", replace: "Note</h1>" }] });
    expect(JSON.parse(patched.content)).toMatchObject({ id: "memo", version: 2 });
    expect((await bare.execute("artifacts.guide", { kind: "doc" })).content).toMatch(/artifacts.check is not available here/);
    expect(registry.defs().find((d) => d.name === "artifacts.write")?.description).toMatch(/check once with artifacts.check/);
    expect(registry.defs().find((d) => d.name === "artifacts.check")?.description).toMatch(/in one pass with artifacts.patch \(artifacts.write only for a redesign\)/);
  });
});
