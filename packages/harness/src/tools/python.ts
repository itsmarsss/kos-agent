import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import type { ToolImage } from "../models/types.js";
import { RESERVED } from "../kernel/files.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { runCaptured, type CapturedRun } from "../sandbox/capture.js";
import { childEnv, findProgram } from "../sandbox/env.js";
import { isContained, jailedProgram } from "../sandbox/jail.js";

/**
 * python.run: a short Python program, run for its answer.
 *
 * The shell asks before anything that runs code, which is right for a shell
 * and wrong for a sum: worked in the head it can be wrong, and a file written
 * and then run is two calls and an approval for one line of arithmetic. This
 * runs at once because of what it cannot do. On macOS the jail gives it no
 * network, the workspace to read but not to write, a fresh folder of its own
 * to write in, and neither the owner's home nor KOS's own files to see. In
 * the container nothing narrower than the container holds it, so there it
 * asks, as the shell does.
 */

export interface PythonModuleOptions {
  /** Longest a program may run, in seconds, unless the call says otherwise. */
  timeoutSeconds?: number;
  /** Longest stdout or stderr kept, in characters. */
  maxOutput?: number;
  /** The interpreter, by name on the child's PATH or by path. */
  python?: string;
  platform?: NodeJS.Platform;
  contained?: boolean;
}

export const PYTHON_TIMEOUT_SECONDS = 30;
export const PYTHON_MAX_TIMEOUT_SECONDS = 300;
export const PYTHON_MAX_OUTPUT = 20_000;
/** Pictures handed back to the model from one run, and the largest one. */
const MAX_PICTURES = 4;
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_LISTED = 50;

export interface PythonResult extends CapturedRun {
  /** What the program left in its folder, workspace-relative. */
  files?: string[];
}

/** An interpreter and the folders it loads its libraries from. */
interface Interpreter {
  file: string;
  libraries: string[];
  /** The owner's user site, which HOME pointed at the workspace would otherwise move. */
  userBase?: string;
}

const PROBE =
  "import json, site, sys; print(json.dumps({'libraries': sorted({sys.prefix, sys.base_prefix, sys.exec_prefix}), 'userBase': site.getuserbase()}))";

/** Where the interpreter's libraries live, asked of it once, as the owner would run it. */
function probe(file: string, path: string): Interpreter {
  try {
    const out = execFileSync(file, ["-c", PROBE], { env: { PATH: path, HOME: homedir() }, timeout: 10_000, encoding: "utf8" });
    const seen = JSON.parse(out) as { libraries: string[]; userBase: string };
    return { file, libraries: [...seen.libraries, seen.userBase], userBase: seen.userBase };
  } catch {
    return { file, libraries: [] };
  }
}

/** A folder name that sorts by when it ran: 20261031-112233-ab12. */
function runId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

const PICTURE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** The files under a folder, relative to it. */
function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile()).sort();
}

function picturesOf(dir: string, files: string[]): ToolImage[] {
  const pictures: ToolImage[] = [];
  for (const f of files) {
    const mediaType = PICTURE_TYPES[extname(f).toLowerCase()];
    if (!mediaType || pictures.length >= MAX_PICTURES) continue;
    const bytes = readFileSync(join(dir, f));
    if (bytes.length <= MAX_PICTURE_BYTES) pictures.push({ mediaType, data: bytes.toString("base64") });
  }
  return pictures;
}

export function createPythonModule(options: PythonModuleOptions = {}): KosModule {
  const timeoutSeconds = options.timeoutSeconds ?? PYTHON_TIMEOUT_SECONDS;
  const maxOutput = options.maxOutput ?? PYTHON_MAX_OUTPUT;
  const contained = options.contained ?? isContained();
  const confined = !contained && (options.platform ?? process.platform) === "darwin";
  let interpreter: Interpreter | undefined;
  return {
    manifest: {
      name: "python",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "python.run", version: "1.0.0" }],
      riskTier: confined ? "safe" : "risky",
    },
    activate(ctx: ModuleContext) {
      const ws = requireServices(ctx).workspace;
      ctx.registerTool(
        {
          name: "python.run",
          description:
            "Run a short Python 3 program and get back what it printed: arithmetic, unit, date and money math, statistics, parsing or reshaping text or a workspace file, a quick chart. " +
            "Use it rather than working a sum out in your head, and rather than writing a file to run with the shell. " +
            (confined
              ? "It runs at once, without asking, because it cannot reach the network or change anything: the workspace is its working directory, to read by workspace-relative path, and it writes only into a fresh folder of its own, os.environ['OUT']. "
              : "It asks the owner first. Its working directory is the workspace; write what should be kept into os.environ['OUT']. ") +
            "Files left in OUT are kept and listed in the result, with their workspace paths; pictures among them (PNG or JPEG, such as plt.savefig(os.path.join(os.environ['OUT'], 'chart.png'))) are shown to you. Point the owner to one with @file:<path>. " +
            "The standard library is there, and whatever packages the machine has installed (numpy and matplotlib when present); nothing can be installed. Print what you need: a last expression is not echoed.",
          inputSchema: {
            type: "object",
            properties: {
              code: { type: "string", description: "the program" },
              timeout: { type: "number", description: `seconds before it is killed (default ${timeoutSeconds}, at most ${PYTHON_MAX_TIMEOUT_SECONDS})` },
            },
            required: ["code"],
          },
        },
        async (input) => {
          const code = typeof input["code"] === "string" ? input["code"] : "";
          if (!code.trim()) throw new Error("code is required");
          const seconds =
            typeof input["timeout"] === "number" && input["timeout"] > 0 ? Math.min(input["timeout"], PYTHON_MAX_TIMEOUT_SECONDS) : timeoutSeconds;
          const id = runId();
          const tmp = join(ws.root, ".kos", "tmp", `python-${id}`);
          const cache = join(ws.root, ".kos", "cache", "python");
          const outRel = `scratch/python/${id}`;
          const out = ws.resolve(outRel);
          const env = childEnv({ home: ws.root, tmp });
          const program = options.python ?? "python3";
          interpreter ??= (() => {
            const file = program.includes("/") ? program : findProgram(program, env.PATH ?? "");
            if (!file) throw new Error(`${program} is not installed on this machine`);
            return probe(file, env.PATH ?? "");
          })();
          for (const dir of [tmp, cache, out]) mkdirSync(dir, { recursive: true });
          const script = join(tmp, "snippet.py");
          writeFileSync(script, code, "utf8");
          try {
            const command = jailedProgram(interpreter.file, [script], {
              workspaceRoot: ws.root,
              writes: [out, tmp, cache],
              hidden: [...RESERVED].map((name) => join(ws.root, name)),
              reads: interpreter.libraries,
              network: false,
              contained,
              ...(options.platform ? { platform: options.platform } : {}),
            });
            const run = await runCaptured(command, {
              cwd: ws.root,
              env: {
                ...env,
                OUT: out,
                MPLBACKEND: "Agg",
                MPLCONFIGDIR: join(cache, "matplotlib"),
                XDG_CACHE_HOME: cache,
                PYTHONDONTWRITEBYTECODE: "1",
                PYTHONIOENCODING: "utf-8",
                ...(interpreter.userBase ? { PYTHONUSERBASE: interpreter.userBase } : {}),
              },
              timeoutMs: seconds * 1000,
              maxOutput,
            });
            const left = filesUnder(out);
            if (left.length === 0) rmSync(out, { recursive: true, force: true });
            const result: PythonResult = {
              ...run,
              ...(left.length ? { files: left.slice(0, MAX_FILES_LISTED).map((f) => `${outRel}/${f}`) } : {}),
            };
            const pictures = picturesOf(out, left);
            const text = JSON.stringify(result);
            return pictures.length ? { text, images: pictures } : text;
          } finally {
            rmSync(tmp, { recursive: true, force: true });
          }
        },
        confined ? { floor: "safe" } : { floor: "risky", why: "Python with nothing narrower than the host to hold it" },
      );
    },
  };
}
