import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { childEnv } from "../sandbox/env.js";
import { jailedCommand } from "../sandbox/jail.js";

/**
 * shell.run: a command, in the workspace, jailed.
 *
 * The one tool the spec calls optional and risky by floor. It runs where
 * the other tools can reach and nowhere else: the working directory is
 * resolved through the path jail, the environment is the allow-list every
 * child gets with HOME pointed at the workspace, and the process itself is
 * confined by the platform's sandbox (see sandbox/jail.ts). It asks every
 * time, or runs under a permission the owner remembered for that program.
 */

export interface ShellModuleOptions {
  /** Longest a command may run, in seconds. */
  timeoutSeconds?: number;
  /** Longest stdout or stderr kept, in characters. */
  maxOutput?: number;
}

export const SHELL_TIMEOUT_SECONDS = 120;
export const SHELL_MAX_OUTPUT = 20_000;

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export function runShell(
  command: string,
  opts: { workspaceRoot: string; cwd: string; timeoutMs: number; maxOutput: number },
): Promise<ShellResult> {
  const tmp = join(opts.workspaceRoot, ".kos", "tmp");
  mkdirSync(tmp, { recursive: true });
  const { file, args } = jailedCommand(command, { workspaceRoot: opts.workspaceRoot });
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: childEnv({ home: opts.workspaceRoot, tmp }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const keep = (current: string, chunk: Buffer): string => {
      if (current.length >= opts.maxOutput) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > opts.maxOutput) {
        truncated = true;
        return next.slice(0, opts.maxOutput);
      }
      return next;
    };
    child.stdout.on("data", (c: Buffer) => { stdout = keep(stdout, c); });
    child.stderr.on("data", (c: Buffer) => { stderr = keep(stderr, c); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, truncated });
    });
  });
}

export function createShellModule(options: ShellModuleOptions = {}): KosModule {
  const timeoutSeconds = options.timeoutSeconds ?? SHELL_TIMEOUT_SECONDS;
  const maxOutput = options.maxOutput ?? SHELL_MAX_OUTPUT;
  return {
    manifest: {
      name: "shell",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "shell.run", version: "1.0.0" }],
      riskTier: "risky",
    },
    activate(ctx: ModuleContext) {
      const ws = requireServices(ctx).workspace;
      ctx.registerTool(
        {
          name: "shell.run",
          description:
            "Run a shell command inside the workspace: git, pnpm, python, a build, a script. It cannot see the owner's home directory or write outside the workspace. Prefer the files, search and sql tools when one does the job; use this for programs. Output is capped; long runs time out.",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string", description: "the command line, run by /bin/sh" },
              cwd: { type: "string", description: "workspace-relative directory to run in; the workspace root by default" },
              timeout: { type: "number", description: `seconds before it is killed (default ${timeoutSeconds})` },
            },
            required: ["command"],
          },
        },
        async (input) => {
          const command = typeof input["command"] === "string" ? input["command"].trim() : "";
          if (!command) throw new Error("command is required");
          const cwdRel = typeof input["cwd"] === "string" && input["cwd"].trim() ? input["cwd"].trim() : ".";
          const cwd = ws.resolve(cwdRel);
          const seconds = typeof input["timeout"] === "number" && input["timeout"] > 0 ? Math.min(input["timeout"], 3600) : timeoutSeconds;
          const result = await runShell(command, { workspaceRoot: ws.root, cwd, timeoutMs: seconds * 1000, maxOutput: maxOutput });
          return JSON.stringify(result);
        },
        { floor: "risky" },
      );
    },
  };
}
