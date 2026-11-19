import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { HashingEmbeddingProvider } from "../memory/embeddings.js";
import { EventLog } from "../memory/events.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createSearchModule } from "./search.js";

/**
 * Resolve a real rg binary without a shell, so a shell alias cannot fake a hit.
 * Grep tests inject this path and skip when the machine has no ripgrep.
 */
function findRipgrep(): string | undefined {
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return undefined;
}

const rgPath = findRipgrep();

describe("search module", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-search-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function load(mod = createSearchModule()): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
    });
    await new ModuleLoader(ctx).load([mod]);
    return registry;
  }

  it.each([["ripgrep", rgPath], ["the scan", "/nonexistent/rg"]] as const)("reads none of KOS's own files through %s: the database, its snapshot, the backup repo", async (_how, path) => {
    if (!path) return;
    const secret = "needle-in-the-database";
    writeFileSync(join(root, "kos.snapshot.sqlite"), `SQLite format 3 ${secret}`);
    mkdirSync(join(root, ".kos", "backup.git"), { recursive: true });
    writeFileSync(join(root, ".kos", "backup.git", "config"), secret);
    writeFileSync(join(root, ".kos", "daemon.log"), secret);
    writeFileSync(join(root, "notes.txt"), secret);
    const registry = await load(createSearchModule({ rgPath: path }));
    const all = await registry.execute("search.grep", { pattern: secret, path: "workspace:" });
    expect(all.content).toContain("notes.txt");
    expect(all.content).not.toMatch(/kos\.snapshot|backup\.git|daemon\.log/);
    for (const target of ["workspace:kos.snapshot.sqlite", "workspace:.kos", "workspace:.kos/backup.git", "workspace:kos.sqlite"]) {
      const one = await registry.execute("search.grep", { pattern: secret, path: target });
      expect(one.isError, target).toBe(true);
      expect(one.content, target).toMatch(/KOS's own/);
    }
  });

  it.skipIf(!rgPath)("greps literal text and reports line numbers", async () => {
    writeFileSync(join(ws.root, "notes.txt"), "alpha\nbeta needle\ngamma\n");
    const registry = await load(createSearchModule({ rgPath }));
    const res = await registry.execute("search.grep", { pattern: "needle" });
    expect(res.isError).toBe(false);
    expect(res.content).toMatch(/notes\.txt/);
    expect(res.content).toMatch(/2:/);
  });

  it.skipIf(!rgPath)("returns a clean empty result for no matches", async () => {
    writeFileSync(join(ws.root, "x.txt"), "nothing here");
    const registry = await load(createSearchModule({ rgPath }));
    const res = await registry.execute("search.grep", { pattern: "zzzmissing" });
    expect(res.isError).toBe(false);
    expect(res.content).toBe("(no matches)");
  });

  /*
   * This used to assert an error. Failing outright takes a core capability
   * away based on what the owner happens to have installed, and the agent has
   * no way to know in advance: it tries, fails, and works around it badly.
   * With no ripgrep the search runs in Node instead.
   */
  it("searches anyway when the rg binary is missing", async () => {
    writeFileSync(join(ws.root, "found.txt"), "first line\nhas a needle in it");
    const registry = await load(
      createSearchModule({ rgPath: join(root, "no-such-rg") }),
    );
    const res = await registry.execute("search.grep", { pattern: "needle" });
    expect(res.isError).toBe(false);
    expect(res.content).toContain("found.txt:2:");
    expect(res.content).toContain("needle");
  });

  it("still says so plainly when nothing matches and there is no rg", async () => {
    writeFileSync(join(ws.root, "found.txt"), "nothing of interest");
    const registry = await load(
      createSearchModule({ rgPath: join(root, "no-such-rg") }),
    );
    const res = await registry.execute("search.grep", { pattern: "zzzmissing" });
    expect(res.isError).toBe(false);
    expect(res.content).toBe("(no matches)");
  });

  it.skipIf(!rgPath)("never lets a pattern or path be read as one of ripgrep's flags", async () => {
    // --pre names a program ripgrep runs on every file it searches: here, a script the agent wrote.
    const marker = join(root, "ran");
    mkdirSync(join(ws.root, "scratch"), { recursive: true });
    writeFileSync(join(ws.root, "scratch", "x.sh"), `#!/bin/sh\ntouch ${marker}\ncat "$1"\n`);
    chmodSync(join(ws.root, "scratch", "x.sh"), 0o755);
    writeFileSync(join(ws.root, "notes.txt"), "a line --pre=/bin/sh in the text\n");
    const registry = await load(createSearchModule({ rgPath }));
    // Patterns that are flags are searched for as text.
    for (const input of [
      { pattern: "--pre=/bin/sh", path: "scratch/x.sh" },
      { pattern: "--pre=scratch/x.sh" },
      { pattern: "-uuu", path: "." },
    ]) {
      const res = await registry.execute("search.grep", input);
      expect(res.isError, JSON.stringify(input)).toBe(false);
    }
    expect((await registry.execute("search.grep", { pattern: "--pre=/bin/sh" })).content).toContain("notes.txt:1:");
    const flagPath = await registry.execute("search.grep", { pattern: "needle", path: "--pre=/bin/sh" });
    expect(flagPath.isError).toBe(true);
    expect(flagPath.content).toContain("reads as a flag");
    // Text that only looks like a flag later in the pattern is searched for, not obeyed.
    const literal = await registry.execute("search.grep", { pattern: "line --pre=/bin/sh" });
    expect(literal.content).toContain("notes.txt:1:");
    expect(existsSync(marker)).toBe(false);
  });

  it("runs ripgrep with the child's environment, never the host's", async () => {
    const fake = join(root, "fake-rg");
    writeFileSync(fake, "#!/bin/sh\nenv\n");
    chmodSync(fake, 0o755);
    process.env.KOS_TEST_SECRET = "do-not-leak";
    try {
      const registry = await load(createSearchModule({ rgPath: fake }));
      const res = await registry.execute("search.grep", { pattern: "anything" });
      expect(res.isError).toBe(false);
      expect(res.content).toContain(`HOME=${ws.root}\n`);
      expect(res.content).not.toContain("do-not-leak");
    } finally {
      delete process.env.KOS_TEST_SECRET;
    }
  });

  it.skipIf(!rgPath)("leaves KOS's own state and database out of a search", async () => {
    mkdirSync(join(ws.root, ".kos", "results"), { recursive: true });
    writeFileSync(join(ws.root, ".kos", "results", "r.json"), "needle from another chat");
    ws.db.exec("CREATE TABLE t (v TEXT)");
    ws.db.prepare("INSERT INTO t (v) VALUES (?)").run("needle in the database");
    writeFileSync(join(ws.root, "notes.txt"), "needle of mine");
    const registry = await load(createSearchModule({ rgPath }));
    const all = await registry.execute("search.grep", { pattern: "needle", path: "workspace:" });
    expect(all.content).toContain("notes.txt");
    expect(all.content).not.toContain("another chat");
    expect(all.content).not.toContain("kos.sqlite");
    // Only the root's own are KOS's: a project's locks/ or profile.json is the project's.
    mkdirSync(join(ws.root, "projects", "p", "locks"), { recursive: true });
    writeFileSync(join(ws.root, "projects", "p", "locks", "a.txt"), "needle in a project");
    writeFileSync(join(ws.root, "projects", "p", "profile.json"), '{"needle": 1}');
    const nested = await registry.execute("search.grep", { pattern: "needle", path: "workspace:" });
    expect(nested.content).toContain("projects/p/locks/a.txt");
    expect(nested.content).toContain("projects/p/profile.json");
    for (const path of ["workspace:.kos/results", "kos.sqlite", "KOS.sqlite-wal"]) {
      const res = await registry.execute("search.grep", { pattern: "needle", path });
      expect(res.isError, path).toBe(true);
    }
  });

  it("only registers grep when no embedder is wired", async () => {
    const registry = await load();
    expect(registry.has("search.grep")).toBe(true);
    expect(registry.has("search.semantic")).toBe(false);
  });

  it("registers semantic search and ranks by similarity when wired", async () => {
    const embedder = new HashingEmbeddingProvider(128);
    const events = new EventLog(ws.db, embedder.dimension, Date.now, embedder.name);
    const [a] = await embedder.embed(["hiking and camping in the mountains"]);
    const [b] = await embedder.embed(["quarterly tax accounting"]);
    events.append({ userId: "owner", role: "owner", text: "hiking and camping in the mountains", projectSlug: "trips" }, a!);
    events.append({ userId: "owner", role: "owner", text: "quarterly tax accounting" }, b!);

    const registry = await load(createSearchModule({ events, embedder }));
    expect(registry.has("search.semantic")).toBe(true);
    const res = await registry.execute("search.semantic", {
      query: "camping trip",
    });
    const hits = JSON.parse(res.content);
    expect(hits[0].text).toContain("hiking");
    expect(hits[0]).toMatchObject({ who: "owner", project: "trips" });
  });
});
