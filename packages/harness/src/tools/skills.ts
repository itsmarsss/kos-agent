import { readFileSync, readdirSync, statSync } from "node:fs";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { runSandbox } from "../sandbox/runner.js";
import { assessSkillRisk } from "../skills/risk.js";
import type { SkillPromoter } from "../skills/promote.js";
import { runSkillLive } from "../skills/run.js";
import type { Workspace } from "../store/workspace.js";

/**
 * The `skills` tool module: the self-improvement loop as ordinary tool use.
 * The agent authors a script with files.write, tests it in the sandbox, and
 * promotes it; running one for real is a separate, always-approved step.
 *
 * KOS.md holds this back until the guardrails exist, and the guardrails are
 * what these tools are: a child process, a throwaway DB copy, dry-run effects,
 * harness-computed risk, and a git snapshot behind every promotion.
 */

export const SKILLS_DIR = "skills";

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

/** Confine skills to the skills directory, on top of the jail's own check. */
function skillPath(entry: string): string {
  const norm = entry.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (!norm.startsWith(`${SKILLS_DIR}/`)) {
    throw new Error(`skills live under ${SKILLS_DIR}/: got ${entry}`);
  }
  if (!norm.endsWith(".js") && !norm.endsWith(".mjs")) {
    throw new Error("a skill must be a .js or .mjs script");
  }
  return norm;
}

function listSkills(ws: Workspace): string[] {
  let dir: string;
  try {
    dir = ws.resolve(SKILLS_DIR);
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
    .map((f) => `${SKILLS_DIR}/${f}`)
    .sort();
}

function defineSkillTools(
  ws: Workspace,
  promoter: SkillPromoter,
  ctx: ModuleContext,
): void {
  ctx.registerTool(
    {
      name: "skills.list",
      description:
        "List the skill scripts in the workspace, with the harness risk verdict for each.",
      inputSchema: { type: "object", properties: {} },
    },
    () =>
      JSON.stringify(
        listSkills(ws).map((entry) => {
          try {
            const assessed = assessSkillRisk(readFileSync(ws.resolve(entry), "utf8"));
            return { entry, risky: assessed.risky, reasons: assessed.reasons };
          } catch {
            return { entry, risky: true, reasons: ["unreadable"] };
          }
        }),
      ),
    { floor: "safe" },
    { tags: ["skills"] },
  );

  ctx.registerTool(
    {
      name: "skills.test",
      description:
        "Run a skill in the sandbox: separate process, throwaway copy of the database, external effects mocked. Nothing it does reaches the live workspace. Returns exit status, output, and the risk verdict.",
      inputSchema: {
        type: "object",
        properties: {
          entry: { type: "string", description: "e.g. skills/weekly-summary.js" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["entry"],
      },
    },
    async (input) => {
      const entry = skillPath(str(input, "entry"));
      const args = Array.isArray(input.args)
        ? (input.args as unknown[]).filter((a): a is string => typeof a === "string")
        : undefined;
      const result = await runSandbox({
        workspaceRoot: ws.root,
        entry,
        ...(args ? { args } : {}),
      });
      const assessed = assessSkillRisk(readFileSync(ws.resolve(entry), "utf8"));
      return JSON.stringify({
        ok: result.ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 4000),
        risk: assessed.risky ? "risky" : "safe",
        reasons: assessed.reasons,
      });
    },
    { floor: "safe" },
    { tags: ["skills"] },
  );

  ctx.registerTool(
    {
      name: "skills.promote",
      description:
        "Sandbox-test a skill and, if it passes and reads as safe, commit it with a git snapshot. A skill that touches the network, credentials, other processes, or any write is queued for owner approval instead. The harness decides which; you do not declare it.",
      inputSchema: {
        type: "object",
        properties: {
          entry: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["entry"],
      },
    },
    async (input) => {
      const entry = skillPath(str(input, "entry"));
      const args = Array.isArray(input.args)
        ? (input.args as unknown[]).filter((a): a is string => typeof a === "string")
        : undefined;
      const outcome = await promoter.promote({
        entry,
        ...(args ? { args } : {}),
      });
      return JSON.stringify(outcome);
    },
    { floor: "safe" },
    { tags: ["skills"] },
  );

  ctx.registerTool(
    {
      name: "skills.commit",
      description:
        "Commit an already-tested skill with a git snapshot. Risky: this is the step an owner approves after a skill is queued.",
      inputSchema: {
        type: "object",
        properties: { entry: { type: "string" } },
        required: ["entry"],
      },
    },
    async (input) => {
      const entry = skillPath(str(input, "entry"));
      const sha = await promoter.commit(entry);
      return JSON.stringify({ status: "promoted", entry, sha });
    },
    { floor: "risky" },
    { tags: ["skills"] },
  );
}

function defineRunTool(ws: Workspace, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "skills.run",
      description:
        "Run a promoted skill for real against the live workspace. Always requires owner approval. Prefer skills.test while iterating.",
      inputSchema: {
        type: "object",
        properties: {
          entry: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["entry"],
      },
    },
    async (input) => {
      const entry = skillPath(str(input, "entry"));
      const args = Array.isArray(input.args)
        ? (input.args as unknown[]).filter((a): a is string => typeof a === "string")
        : undefined;
      const result = await runSkillLive({
        workspaceRoot: ws.root,
        entry,
        ...(args ? { args } : {}),
      });
      return JSON.stringify({
        ok: result.ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 4000),
      });
    },
    // Executing agent-written code against the live workspace is never safe,
    // whatever the source scan says, so this floor is unconditional.
    { floor: "risky" },
    { tags: ["skills"] },
  );
}

export function createSkillsModule(promoter: SkillPromoter): KosModule {
  return {
    manifest: {
      name: "skills",
      version: "1.0.0",
      provides: [
        { kind: "tool", name: "skills.list", version: "1.0.0" },
        { kind: "tool", name: "skills.test", version: "1.0.0" },
        { kind: "tool", name: "skills.promote", version: "1.0.0" },
        { kind: "tool", name: "skills.commit", version: "1.0.0" },
        { kind: "tool", name: "skills.run", version: "1.0.0" },
      ],
      riskTier: "risky",
    },
    activate(ctx) {
      const { workspace } = requireServices(ctx);
      defineSkillTools(workspace, promoter, ctx);
      defineRunTool(workspace, ctx);
    },
  };
}
