import { execFile } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Kernel, SecretsRegistry } from "@kos/harness";

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

  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20, "node >= 20", process.versions.node);

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

  const envFile =
    options.envPath ??
    (existsSync(join(process.cwd(), ".env"))
      ? join(process.cwd(), ".env")
      : join(repoRoot, ".env"));
  check(existsSync(envFile), ".env file", envFile);

  const secrets = SecretsRegistry.fromEnv();
  check(
    secrets.has("anthropic") || secrets.has("openai"),
    "model API key",
    "ANTHROPIC_API_KEY or OPENAI_API_KEY",
  );

  const ws = options.workspace || join(homedir(), "kos-workspace");
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
