import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { EpisodicStore } from "../memory/episodic.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import type { Workspace } from "../store/workspace.js";

const exec = promisify(execFile);

export interface SearchModuleOptions {
  /** Wire these to enable the semantic search tool; grep needs neither. */
  episodic?: EpisodicStore;
  embedder?: EmbeddingProvider;
  /** ripgrep binary; injectable for tests. */
  rgPath?: string;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

/**
 * Exact grep via ripgrep, jailed to the workspace. The optional `path` arg is
 * resolved through the jail, so the search can never read outside the root.
 * ripgrep exits 1 with no matches, which is a normal empty result, not an error.
 */
async function grep(
  ws: Workspace,
  rgPath: string,
  input: Record<string, unknown>,
): Promise<string> {
  const pattern = str(input, "pattern");
  const rel = typeof input.path === "string" ? input.path : ".";
  const target = ws.resolve(rel);
  try {
    const { stdout } = await exec(
      rgPath,
      ["--line-number", "--no-heading", "--color", "never", pattern, target],
      { cwd: ws.root, maxBuffer: 4_000_000 },
    );
    return stdout.trim() || "(no matches)";
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1) return "(no matches)"; // ripgrep: no matches found
    throw err;
  }
}

export function defineSearchTools(
  ws: Workspace,
  ctx: ModuleContext,
  opts: SearchModuleOptions,
): void {
  const rgPath = opts.rgPath ?? "rg";

  ctx.registerTool(
    {
      name: "search.grep",
      description:
        "Exact/literal text search across the workspace via ripgrep. Optional path scopes the search.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
    (input) => grep(ws, rgPath, input),
    { floor: "safe" },
  );

  if (opts.episodic && opts.embedder) {
    const episodic = opts.episodic;
    const embedder = opts.embedder;
    ctx.registerTool(
      {
        name: "search.semantic",
        description:
          "Semantic/concept search over episodic memory (vector similarity).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            userId: { type: "string" },
            k: { type: "number" },
          },
          required: ["query"],
        },
      },
      async (input) => {
        const [embedding] = await embedder.embed([str(input, "query")]);
        if (!embedding) return "[]";
        const userId = typeof input.userId === "string" ? input.userId : "owner";
        const k = typeof input.k === "number" ? input.k : 5;
        const hits = episodic.search(userId, embedding, k);
        return JSON.stringify(
          hits.map((h) => ({ text: h.text, distance: h.distance })),
        );
      },
      { floor: "safe" },
    );
  }
}

/**
 * The `search` tool module: exact grep (ripgrep) plus optional semantic search
 * (embeddings via sqlite-vec). Both read-only and safe. Semantic registers only
 * when an episodic store and embedder are wired.
 */
export function createSearchModule(opts: SearchModuleOptions = {}): KosModule {
  const provides = [{ kind: "tool" as const, name: "search.grep", version: "1.0.0" }];
  if (opts.episodic && opts.embedder) {
    provides.push({ kind: "tool", name: "search.semantic", version: "1.0.0" });
  }
  return {
    manifest: { name: "search", version: "1.0.0", provides, riskTier: "safe" },
    activate(ctx) {
      const { workspace } = requireServices(ctx);
      defineSearchTools(workspace, ctx, opts);
    },
  };
}
