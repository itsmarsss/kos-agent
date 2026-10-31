import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import { RESERVED } from "../kernel/files.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { runCaptured } from "../sandbox/capture.js";
import { childEnv, findProgram } from "../sandbox/env.js";
import { isContained, jailedProgram } from "../sandbox/jail.js";

/**
 * tex.pdf: a LaTeX document in the workspace, typeset.
 *
 * Tectonic, because it is one program that fetches the packages a document
 * names as it needs them, where a TeX distribution is gigabytes installed
 * up front. It runs jailed with shell escape off (--untrusted), so a
 * document can typeset and do nothing else: it reads the workspace but
 * neither KOS's own files nor the owner's home, and writes only its cache
 * and a scratch folder, from which the PDF is moved next to the source.
 * The network stays open for the package bundle.
 */

export interface TexModuleOptions {
  timeoutSeconds?: number;
  /** The typesetter, by name on the child's PATH or by path. */
  tectonic?: string;
  /** Where fetched packages are kept; the workspace's .kos/cache/tectonic by default. */
  cache?: string;
  platform?: NodeJS.Platform;
  contained?: boolean;
}

/** Long enough for a first run, which fetches the bundle and builds the format. */
export const TEX_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_LOG = 20_000;
/** What of a failed run's log the model is shown: the end, where TeX stops. */
const LOG_TAIL = 4_000;
const MAX_WARNINGS = 20;

export interface TexResult {
  ok: boolean;
  /** The PDF, workspace-relative, when it was made. */
  pdf?: string;
  warnings?: string[];
  /** The end of what Tectonic said, when it failed. */
  log?: string;
  timedOut?: boolean;
}

export function createTexModule(options: TexModuleOptions = {}): KosModule {
  const timeoutSeconds = options.timeoutSeconds ?? TEX_TIMEOUT_SECONDS;
  const contained = options.contained ?? isContained();
  const confined = !contained && (options.platform ?? process.platform) === "darwin";
  return {
    manifest: {
      name: "tex",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "tex.pdf", version: "1.0.0" }],
      riskTier: confined ? "safe" : "risky",
    },
    activate(ctx: ModuleContext) {
      const ws = requireServices(ctx).workspace;
      ctx.registerTool(
        {
          name: "tex.pdf",
          description:
            "Typeset a LaTeX document in the workspace into a PDF beside it (notes.tex becomes notes.pdf), for a document the owner will print, send or keep. Write the .tex with files.write first. " +
            "Packages the document uses are fetched as needed, so the first run takes a minute and later ones a second or two. Shell escape is off. " +
            "On a TeX error the result carries the end of the log, with the line it stopped at; fix the source and run it again. Point the owner to the PDF with @file:<path>. " +
            "For a formula in a reply, write the math in the reply itself instead: the dashboard and the side panel render $...$ and $$...$$.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "workspace-relative path of the .tex file" },
              timeout: { type: "number", description: `seconds before it is stopped (default ${timeoutSeconds})` },
            },
            required: ["path"],
          },
        },
        async (input) => {
          const rel = typeof input["path"] === "string" ? input["path"].trim() : "";
          if (extname(rel).toLowerCase() !== ".tex") throw new Error("path must name a .tex file");
          const source = ws.resolve(rel);
          if (!existsSync(source)) throw new Error(`no such file: ${rel}`);
          const seconds =
            typeof input["timeout"] === "number" && input["timeout"] > 0 ? Math.min(input["timeout"], MAX_TIMEOUT_SECONDS) : timeoutSeconds;
          const tmp = join(ws.root, ".kos", "tmp", `tex-${randomBytes(4).toString("hex")}`);
          const cache = options.cache ?? join(ws.root, ".kos", "cache", "tectonic");
          // HOME is the cache too: Tectonic keeps the bundle in its cache
          // folder but the formats it builds under $HOME/Library/Caches.
          const env = childEnv({ home: cache, tmp }, { TECTONIC_CACHE_DIR: cache, XDG_CACHE_HOME: cache });
          const program = options.tectonic ?? "tectonic";
          const file = program.includes("/") ? program : findProgram(program, env.PATH ?? "");
          if (!file) throw new Error("tectonic is not installed on this machine; `brew install tectonic` puts it there");
          for (const dir of [tmp, cache]) mkdirSync(dir, { recursive: true });
          try {
            const command = jailedProgram(file, ["-X", "compile", "--untrusted", "--outdir", tmp, basename(source)], {
              workspaceRoot: ws.root,
              writes: [tmp, cache],
              hidden: [...RESERVED].map((name) => join(ws.root, name)),
              contained,
              ...(options.platform ? { platform: options.platform } : {}),
            });
            const run = await runCaptured(command, { cwd: dirname(source), env, timeoutMs: seconds * 1000, maxOutput: MAX_LOG });
            const said = `${run.stdout}\n${run.stderr}`;
            const warnings = said.split("\n").filter((l) => l.startsWith("warning:")).slice(0, MAX_WARNINGS);
            const made = join(tmp, `${basename(source, extname(source))}.pdf`);
            if (run.exitCode !== 0 || !existsSync(made)) {
              const failed: TexResult = { ok: false, log: said.trim().slice(-LOG_TAIL), ...(run.timedOut ? { timedOut: true } : {}) };
              return JSON.stringify(failed);
            }
            const pdf = join(dirname(source), basename(made));
            renameSync(made, pdf);
            const done: TexResult = { ok: true, pdf: relative(ws.root, pdf), ...(warnings.length ? { warnings } : {}) };
            return JSON.stringify(done);
          } finally {
            rmSync(tmp, { recursive: true, force: true });
          }
        },
        confined ? { floor: "safe" } : { floor: "risky", why: "TeX with nothing narrower than the host to hold it" },
      );
    },
  };
}
