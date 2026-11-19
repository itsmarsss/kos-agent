import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { turnStop } from "../kernel/caller.js";
import { firstSegment, foldName, RESERVED } from "../kernel/files.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { EventLog } from "../memory/events.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { childEnv, findProgram } from "../sandbox/env.js";
import { jailedProgram, type JailedCommand } from "../sandbox/jail.js";
import type { Workspace } from "../store/workspace.js";
import { isKosState, reservedReadRefusal } from "./files.js";
import { maintains } from "./fence.js";
import { placeFor } from "./home.js";
import { scan } from "./scan.js";
import { reachOf } from "./sql.js";

const exec = promisify(execFile);

/** Longest a grep may run before it is killed. */
export const GREP_TIMEOUT_MS = 30_000;

export interface SearchModuleOptions {
  /** Wire these to enable the semantic search tool; grep needs neither. */
  events?: EventLog;
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
 * The program to run for a grep: ripgrep in the jail a read-only shell line
 * gets (no writes, no network, sealed, none of KOS's own files) where this
 * platform has one. Where it has none the grep still runs, since its
 * arguments can no longer name a program and its environment is the
 * child's allow-list, not the host's.
 */
function grepProgram(ws: Workspace, rgPath: string, args: string[], hidden: string[]): JailedCommand {
  try {
    return jailedProgram(rgPath, args, { workspaceRoot: ws.root, writes: [], hidden, network: false, sealed: true });
  } catch {
    return { file: rgPath, args };
  }
}

/**
 * Exact grep via ripgrep, jailed to the workspace. The optional `path` arg
 * starts from the calling turn's own folder, as every file tool's does, and
 * is resolved through the jail, so the search can never read outside the root.
 * The pattern goes after -e and the folder after --, so neither is ever read
 * as one of ripgrep's flags (--pre names a program it runs on every file).
 * KOS's own state and database are left out, as files.read leaves them.
 * ripgrep exits 1 with no matches, which is a normal empty result, not an error.
 * With no ripgrep on the child's PATH the search runs in Node instead.
 */
async function grep(
  ws: Workspace,
  ctx: ModuleContext,
  rgPath: string,
  input: Record<string, unknown>,
): Promise<string> {
  const pattern = str(input, "pattern");
  const asked = typeof input.path === "string" ? input.path : ".";
  if (pattern.startsWith("-") || asked.startsWith("-")) {
    throw new Error("a pattern or path starting with - is read as a flag: search for the text after it, or start the path with ./");
  }
  const placed = placeFor(ws, ctx, asked);
  const reach = reachOf(ctx);
  if (isKosState(ws, placed.rel)) throw new Error(".kos is KOS's own state and is not searched; a result set aside in this chat comes back with context.recall");
  const refused = reservedReadRefusal(ws, placed.rel, reach);
  if (refused) throw new Error(refused);
  // What a search walks past, by name at any depth: .kos always, the rest of KOS's own unless Maintenance asks.
  const left = [...RESERVED].filter((name) => name === ".kos" || !maintains(reach));
  const globs = left.flatMap((name) => ["--iglob", `!${name}`]);
  const args = ["--line-number", "--no-heading", "--color", "never", ...globs, "-e", pattern, "--", placed.abs];
  const env = childEnv({ home: ws.root });
  const binary = rgPath.includes("/") ? (existsSync(rgPath) ? rgPath : undefined) : findProgram(rgPath, env.PATH ?? "");
  if (!binary) {
    /*
     * No ripgrep on this machine. Search anyway.
     *
     * This used to throw, which took a core capability away based on what
     * the owner happened to have installed, and the agent had no way to know
     * in advance: it would try, fail, and work around it badly. Note that
     * `rg` being on an interactive PATH proves nothing, because it is often
     * a shell function, and a spawned process cannot call one of those.
     */
    const skipped = new Set(left);
    const result = scan(ws.root, placed.abs, pattern, { skip: (rel) => skipped.has(foldName(firstSegment(rel))) });
    if (result.lines.length === 0) return "(no matches)";
    return [...result.lines, result.truncated ? "(stopped early: too many matches or files)" : ""].filter(Boolean).join("\n");
  }
  const program = grepProgram(ws, binary, args, [...left, ".env"].map((name) => join(ws.root, name)));
  const signal = turnStop.getStore();
  try {
    const { stdout } = await exec(program.file, program.args, {
      cwd: ws.root,
      env,
      maxBuffer: 4_000_000,
      timeout: GREP_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return stdout.trim() || "(no matches)";
  } catch (err) {
    if ((err as { code?: number | string }).code === 1) return "(no matches)"; // ripgrep: no matches found
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
        "Exact/literal text search via ripgrep, in your own folder (your project's, or the whole workspace at the root) unless path says where: a relative path is inside your folder, workspace:<path> is from the workspace root, and workspace: alone searches everything.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
    (input) => grep(ws, ctx, rgPath, input),
    { floor: "safe" },
  );

  if (opts.events && opts.embedder) {
    const events = opts.events;
    const embedder = opts.embedder;
    ctx.registerTool(
      {
        name: "search.semantic",
        description:
          "Search everything that has been said, by meaning and by words at once: what the owner and KOS said in any conversation, with when and where.",
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
        const hits = events.search({ userId, query: str(input, "query"), embedding, k });
        return JSON.stringify(
          hits.map((h) => ({
            text: h.text,
            who: h.role,
            when: new Date(h.ts).toISOString(),
            ...(h.projectSlug ? { project: h.projectSlug } : {}),
            ...(h.conversationId ? { conversation: h.conversationId } : {}),
          })),
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
  if (opts.events && opts.embedder) {
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
