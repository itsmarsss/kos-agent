import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
