import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { runSandbox } from "../sandbox/runner.js";
import {
  MANIFEST_FILE,
  SKILL_NAME,
  SKILLS_DIR,
  readSkills,
  type SkillKind,
  type SkillRecord,
} from "../skills/manifest.js";
import type { SkillPromoter } from "../skills/promote.js";
import { assessSkillRisk } from "../skills/risk.js";
import { runSkillLive } from "../skills/run.js";
import type { Workspace } from "../store/workspace.js";

/**
 * The `skills` tools: making, testing, promoting, using and running skills.
 *
 * A skill is named, not pathed. The model says which skill it means and the
 * manifest says where the file is, so a tool can never be pointed at a file
 * outside a skill's own directory: the name is validated against a pattern
 * that has no separators in it, and the directory it names is resolved
 * through the jail.
 *
 * The owner can switch a skill off by name. A switched-off skill is still on
 * disk and still listed, marked off, but cannot be used or run.
 */

export interface SkillsModuleDeps {
  promoter: SkillPromoter;
  /** Names the owner has switched off, read fresh so a toggle takes effect at once. */
  disabled: () => string[];
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} is required`);
  return v.trim();
}

function strings(input: Record<string, unknown>, key: string): string[] | undefined {
  const v = input[key];
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : undefined;
}

function find(ws: Workspace, name: string): SkillRecord {
  if (!SKILL_NAME.test(name)) throw new Error(`not a skill name: ${name}`);
  const { skills, invalid } = readSkills(ws);
  const found = skills.find((s) => s.manifest.name === name);
  if (found) return found;
  const broken = invalid.find((i) => i.name === name);
  if (broken) throw new Error(`skill ${name} is not usable: ${broken.reason}`);
  throw new Error(`no skill named ${name}; skills.list shows what exists`);
}

function script(skill: SkillRecord): SkillRecord {
  if (skill.manifest.kind !== "script") {
    throw new Error(`${skill.manifest.name} is a prompt skill: read it with skills.use, there is nothing to run`);
  }
  return skill;
}

function sandboxReport(result: { ok: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
  };
}

export function createSkillsModule(deps: SkillsModuleDeps): KosModule {
  return {
    manifest: {
      name: "skills",
      version: "1.0.0",
      provides: [
        { kind: "tool", name: "skills.list", version: "1.0.0" },
        { kind: "tool", name: "skills.create", version: "1.0.0" },
        { kind: "tool", name: "skills.use", version: "1.0.0" },
        { kind: "tool", name: "skills.test", version: "1.0.0" },
        { kind: "tool", name: "skills.promote", version: "1.0.0" },
        { kind: "tool", name: "skills.commit", version: "1.0.0" },
        { kind: "tool", name: "skills.run", version: "1.0.0" },
      ],
      riskTier: "risky",
    },
    activate(ctx: ModuleContext) {
      const ws = requireServices(ctx).workspace;
      const off = (): Set<string> => new Set(deps.disabled());
      const assertOn = (skill: SkillRecord): void => {
        if (off().has(skill.manifest.name)) {
          throw new Error(`${skill.manifest.name} is switched off by the owner; it can be turned on in Settings`);
        }
      };

      ctx.registerTool(
        {
          name: "skills.list",
          description:
            "Every skill in the workspace: name, kind, description, whether it is on, and for a script the harness's risk verdict. Also names any that could not be read and why.",
          inputSchema: { type: "object", properties: {} },
        },
        () => {
          const { skills, invalid } = readSkills(ws);
          const disabled = off();
          return JSON.stringify({
            skills: skills.map((s) => ({
              ...s.manifest,
              enabled: !disabled.has(s.manifest.name),
              ...(s.manifest.kind === "script"
                ? (() => {
                    const assessed = assessSkillRisk(readFileSync(ws.resolve(s.file), "utf8"));
                    return { risk: assessed.risky ? "risky" : "safe", reasons: assessed.reasons };
                  })()
                : {}),
            })),
            invalid,
          });
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "skills.create",
          description:
            "Make a new skill. A prompt skill is instructions for a kind of task, loaded when you call skills.use. A script skill is code the sandbox tests and skills.promote approves before skills.run may run it. Name it plainly; describe it in one sentence so it can be chosen from a list.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "lowercase, digits, - and _ only" },
              description: { type: "string" },
              kind: { type: "string", enum: ["script", "prompt"] },
              content: { type: "string", description: "the script source, or the instructions" },
              projects: { type: "array", items: { type: "string" }, description: "project slugs it is for; omit for everywhere" },
            },
            required: ["name", "description", "kind", "content"],
          },
        },
        (input) => {
          const name = str(input, "name");
          if (!SKILL_NAME.test(name)) throw new Error(`not a skill name: ${name}`);
          const kind = str(input, "kind") as SkillKind;
          if (kind !== "script" && kind !== "prompt") throw new Error('kind must be "script" or "prompt"');
          const description = str(input, "description");
          const content = str(input, "content");
          const projects = strings(input, "projects")?.filter((p) => p.trim() !== "");
          const dirRel = `${SKILLS_DIR}/${name}`;
          const dirAbs = ws.resolve(dirRel);
          if (existsSync(dirAbs)) throw new Error(`a skill named ${name} already exists`);
          mkdirSync(dirAbs, { recursive: true });
          const file = kind === "script" ? "run.mjs" : "SKILL.md";
          const manifest = {
            name,
            description,
            kind,
            ...(kind === "script" ? { entry: file } : { instructions: file }),
            ...(projects?.length ? { projects } : {}),
          };
          writeFileSync(join(dirAbs, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
          writeFileSync(join(dirAbs, file), content.endsWith("\n") ? content : `${content}\n`, "utf8");
          return JSON.stringify({
            created: name,
            kind,
            file: `${dirRel}/${file}`,
            next: kind === "script" ? "skills.test, then skills.promote" : "skills.use when a task matches",
          });
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "skills.use",
          description:
            "Read a prompt skill's instructions into this turn. Call it when a task matches a skill from the list, then follow what it says.",
          inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
        (input) => {
          const skill = find(ws, str(input, "name"));
          if (skill.manifest.kind !== "prompt") {
            throw new Error(`${skill.manifest.name} is a script skill: run it with skills.run`);
          }
          assertOn(skill);
          return readFileSync(ws.resolve(skill.file), "utf8");
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "skills.test",
          description:
            "Run a script skill in the sandbox: a throwaway copy of the database, dry-run effects, nothing touches the live workspace. Reports the result and the harness's risk verdict.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
            required: ["name"],
          },
        },
        async (input) => {
          const skill = script(find(ws, str(input, "name")));
          const args = strings(input, "args");
          const result = await runSandbox({ workspaceRoot: ws.root, entry: skill.file, ...(args ? { args } : {}) });
          const assessed = assessSkillRisk(readFileSync(ws.resolve(skill.file), "utf8"));
          return JSON.stringify({
            ...sandboxReport(result),
            risk: assessed.risky ? "risky" : "safe",
            reasons: assessed.reasons,
          });
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "skills.promote",
          description:
            "Test a script skill in the sandbox and, if it passes, promote it: a safe one is committed at once, a risky one goes to the owner for approval.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
            required: ["name"],
          },
        },
        async (input) => {
          const skill = script(find(ws, str(input, "name")));
          const args = strings(input, "args");
          return JSON.stringify(await deps.promoter.promote({ entry: skill.file, ...(args ? { args } : {}) }));
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "skills.commit",
          description: "Commit a script skill as promoted, without the sandbox. Only after the owner has approved it.",
          inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
        async (input) => {
          const skill = script(find(ws, str(input, "name")));
          const sha = await deps.promoter.commit(skill.file);
          return JSON.stringify({ status: "promoted", name: skill.manifest.name, sha });
        },
        { floor: "risky" },
      );

      ctx.registerTool(
        {
          name: "skills.run",
          description:
            "Run a script skill for real, against the live workspace. Only a promoted skill; test first with skills.test.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
            required: ["name"],
          },
        },
        async (input) => {
          const skill = script(find(ws, str(input, "name")));
          assertOn(skill);
          const args = strings(input, "args");
          const result = await runSkillLive({ workspaceRoot: ws.root, entry: skill.file, ...(args ? { args } : {}) });
          return JSON.stringify(sandboxReport(result));
        },
        { floor: "risky" },
      );
    },
  };
}
