import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { HashingEmbeddingProvider } from "../memory/embeddings.js";
import { EpisodicStore } from "../memory/episodic.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createSearchModule } from "./search.js";

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

  it("greps literal text and reports line numbers", async () => {
    writeFileSync(join(ws.root, "notes.txt"), "alpha\nbeta needle\ngamma\n");
    const registry = await load();
    const res = await registry.execute("search.grep", { pattern: "needle" });
    expect(res.isError).toBe(false);
    expect(res.content).toMatch(/notes\.txt/);
    expect(res.content).toMatch(/2:/);
  });

  it("returns a clean empty result for no matches", async () => {
    writeFileSync(join(ws.root, "x.txt"), "nothing here");
    const registry = await load();
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
    const episodic = new EpisodicStore(ws.db, embedder.dimension);
    const [a] = await embedder.embed(["hiking and camping in the mountains"]);
    const [b] = await embedder.embed(["quarterly tax accounting"]);
    episodic.add("owner", "hiking and camping in the mountains", a!);
    episodic.add("owner", "quarterly tax accounting", b!);

    const registry = await load(createSearchModule({ episodic, embedder }));
    expect(registry.has("search.semantic")).toBe(true);
    const res = await registry.execute("search.semantic", {
      query: "camping trip",
    });
    const hits = JSON.parse(res.content);
    expect(hits[0].text).toContain("hiking");
  });
});
