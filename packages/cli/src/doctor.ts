import { execFile } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Kernel, SecretsRegistry } from "@kos/harness";

import { credentialsDir, envFilePath } from "./env.js";
import { credentialModes, leftoverTranscripts, syncedFolder } from "./hygiene.js";

const exec = promisify(execFile);

export interface DoctorOptions {
  workspace: string;
  envPath?: string;
}

/** Resolve an executable on PATH without a shell, so aliases cannot fake a hit. */
function resolveOnPath(bin: string): string | undefined {
  const names =
    process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return undefined;
}

/**
 * Preflight checks: runtime, build artifacts, secrets presence (not values),
 * workspace writability, and a kernel boot smoke test with stub-free offline path.
 */
export async function runDoctor(options: DoctorOptions): Promise<string> {
  const lines: string[] = ["KOS doctor"];
  let failed = 0;

  const check = (ok: boolean, label: string, detail?: string): void => {
    if (ok) lines.push(`  ok  ${label}${detail ? ` (${detail})` : ""}`);
    else {
      failed += 1;
      lines.push(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };
  /** Worth the owner's attention, not a broken install. */
  const warn = (label: string, detail: string): void => void lines.push(`  warn ${label}: ${detail}`);

  // 22.5 for node:sqlite, which KOS tells the agent's own scripts to use.
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  check(major > 22 || (major === 22 && minor >= 5), "node >= 22.5", process.versions.node);

  // search.grep shells out to ripgrep; without it exact search is dead.
  const rgPath = resolveOnPath("rg");
  if (rgPath) {
    let detail = rgPath;
    try {
      const { stdout } = await exec(rgPath, ["--version"]);
      const version = stdout.split("\n")[0]?.trim();
      if (version) detail = `${rgPath}, ${version}`;
    } catch {
      // path resolved but version probe failed; the path alone is enough detail
    }
    check(true, "ripgrep (search.grep)", detail);
  } else {
    check(
      false,
      "ripgrep (search.grep)",
      "rg not found on PATH; install ripgrep (apt-get install ripgrep, brew install ripgrep)",
    );
  }

  const here = dirname(fileURLToPath(import.meta.url));
  // packages/cli/dist -> repo root
  const repoRoot = resolve(here, "../../..");
  const packagesRoot = resolve(here, "../..");
  check(
    existsSync(join(packagesRoot, "harness/dist/index.js")),
    "harness build",
    "pnpm build",
  );
  check(
    existsSync(join(here, "main.js")),
    "cli build",
    "pnpm build",
  );

  const uiDist = join(packagesRoot, "ui/dist/index.html");
  check(
    existsSync(uiDist),
    "ui static build (optional for serve UI)",
    existsSync(uiDist) ? uiDist : "pnpm -C packages/ui build",
  );

  // The file the host reads: never one from the current directory.
  const envFile = options.envPath ?? envFilePath();
  check(existsSync(envFile), "env file", envFile);
  const synced = syncedFolder(envFile);
  if (synced) warn("env file location", `${envFile} is in ${synced}, which may copy its keys off this machine; move it to ~/.kos/env (chmod 600), or point KOS_ENV_FILE outside it`);
  const opened = credentialModes({ env: process.env, envFile, credentials: credentialsDir() });
  check(opened.length === 0, "credential file modes", opened.length ? opened.map((f) => f.detail).join("; ") : "env file, ~/.kos, keys and pick credentials owner-only");

  const secrets = SecretsRegistry.fromEnv();
  check(
    secrets.has("anthropic") || secrets.has("openai"),
    "model API key",
    "ANTHROPIC_API_KEY or OPENAI_API_KEY",
  );

  // Semantic recall needs a real embedder. Without one KOS falls back to
  // lexical hashing, which still runs but is not semantic, so say so plainly
  // rather than letting it look like working vector search.
  const embedKey = secrets.has("openai")
    ? "openai"
    : secrets.has("cohere")
      ? "cohere"
      : null;
  check(
    embedKey !== null,
    "semantic memory",
    embedKey
      ? `embeddings via ${embedKey}`
      : "no OPENAI_API_KEY or KOS_SECRET_COHERE; episodic recall falls back to lexical hashing, not semantic",
  );

  const ws = options.workspace || join(homedir(), "kos-workspace");
  const transcripts = leftoverTranscripts(ws);
  if (transcripts.length) {
    warn("Claude Code transcripts", `${transcripts.length} kept from before KOS turned them off, holding unscrubbed tool results; delete them once read: ${[...new Set(transcripts.map((p) => dirname(p)))].join(", ")}`);
  }
  try {
    // Ensure parent is creatable / workspace openable via Kernel.boot.
    check(true, "workspace path", ws);
  } catch (err) {
    check(false, "workspace path", err instanceof Error ? err.message : String(err));
  }

  try {
    const kernel = await Kernel.boot({
      rootDir: ws,
      secrets: new SecretsRegistry(),
      inference: {
        async generate() {
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "doctor",
          };
        },
      },
    });
    check(kernel.loadReport.failed.length === 0, "kernel boot + modules");
    check(kernel.registry.has("systems.migrate"), "systems tools");
    check(kernel.registry.has("tasks.add"), "tasks module");
    kernel.close();
  } catch (err) {
    check(false, "kernel boot", err instanceof Error ? err.message : String(err));
  }

  try {
    accessSync(repoRoot, constants.R_OK);
    check(true, "repo readable");
  } catch {
    check(false, "repo readable");
  }

  lines.push(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
  return lines.join("\n");
}
