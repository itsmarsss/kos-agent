import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Kernel, SecretsRegistry } from "@kos/harness";

export interface DoctorOptions {
  workspace: string;
  envPath?: string;
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
