import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { jailedProgram } from "../sandbox/jail.js";
import { runSandbox, type SkillJail } from "../sandbox/runner.js";
import {
  MANIFEST_FILE,
  SKILL_NAME,
  SKILLS_DIR,
  readSkills,
  skillHash,
  skillHashNow,
  type SkillKind,
  type SkillRecord,
} from "../skills/manifest.js";
import type { SkillPromoter } from "../skills/promote.js";
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
 *
 * A script skill only ever runs in the jail, tested or for real, and is
 * refused where there is none. It is promoted only on the owner's yes to
 * its files as they are, asked every time: nothing reads its source and
 * calls it safe.
 */

export interface SkillsModuleDeps {
  promoter: SkillPromoter;
  /** Names the owner has switched off, read fresh so a toggle takes effect at once. */
  disabled: () => string[];
  /** Script skills promoted, by the sandbox or an approved commit, with their files' hash then: these run without asking while it holds. */
  promoted: () => Record<string, string>;
  /** A skill just promoted, kept with the hash of the files that were. */
  markPromoted: (name: string, hash: string) => void;
  /** Where the jail comes from; the platform's own by default. */
  jail?: SkillJail;
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
      /** The script skill a call names, or nothing: for judging a call, which must not throw. */
      const scriptNamed = (input: Record<string, unknown>): SkillRecord | undefined => {
        try {
          return script(find(ws, str(input, "name")));
        } catch {
          return undefined;
        }
      };
      /** Any skill by name, a prompt skill's included, or none. */
      const named = (input: Record<string, unknown>): SkillRecord | undefined => {
        try {
          return find(ws, str(input, "name"));
        } catch {
          return undefined;
        }
      };
      const hashNow = (skill: SkillRecord): string | undefined => skillHashNow(ws, skill);
      const isPromoted = (skill: SkillRecord): boolean => {
        const hash = hashNow(skill);
        return hash !== undefined && deps.promoted()[skill.manifest.name] === hash;
      };
      /** Why a script cannot run on this machine, refused before anyone is asked: there is no jail for it. */
      const noJail = (): string | false => {
        try {
          jailedProgram(process.execPath, [], { workspaceRoot: ws.root, ...deps.jail });
          return false;
        } catch (err) {
          return `a script skill runs only in a jail, and ${err instanceof Error ? err.message : String(err)}`;
        }
      };
      const assertOn = (skill: SkillRecord): void => {
        if (off().has(skill.manifest.name)) {
          throw new Error(`${skill.manifest.name} is switched off by the owner; it can be turned on in Settings`);
        }
      };

      ctx.registerTool(
        {
          name: "skills.list",
          description:
            "Every skill in the workspace: name, kind, description, whether it is on, and for a script whether it is promoted (the owner approved its files as they are now). Also names any that could not be read and why.",
          inputSchema: { type: "object", properties: {} },
        },
        () => {
          const { skills, invalid } = readSkills(ws);
          const disabled = off();
          return JSON.stringify({
            skills: skills.map((s) => ({
              ...s.manifest,
              enabled: !disabled.has(s.manifest.name),
              ...(s.manifest.kind === "script" ? { promoted: isPromoted(s) } : {}),
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
            "Make a new skill. A prompt skill is instructions for a kind of task, loaded when you call skills.use. A script skill is code the sandbox tests; skills.promote asks the owner to keep it, and once they say yes skills.run runs it without asking. Name it plainly; describe it in one sentence so it can be chosen from a list.",
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
        {
          floor: "safe",
          // Instructions the owner has not kept as they are now are text anyone with a write to the folder could have put there.
          untrusted: (input) => {
            const skill = named(input);
            return skill && !isPromoted(skill) ? { kind: "file", where: `skill ${skill.manifest.name}, not kept as it is` } : undefined;
          },
        },
      );

      ctx.registerTool(
        {
          name: "skills.test",
          description:
            "Run a script skill in the sandbox: jailed, no network, a throwaway copy of the database and of the skill's folder, dry-run effects; nothing touches the live workspace. Reports the result.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
            required: ["name"],
          },
        },
        async (input) => {
          const skill = script(find(ws, str(input, "name")));
          const args = strings(input, "args");
          const result = await runSandbox({ workspaceRoot: ws.root, entry: skill.file, ...(args ? { args } : {}), ...(deps.jail ? { jail: deps.jail } : {}) });
          return JSON.stringify(sandboxReport(result));
        },
        { floor: "safe", refuse: () => noJail() },
      );

      /** The owner's yes holds for the files they were shown; changed since, it is not a yes to these. */
      const assertAsked = (skill: SkillRecord, input: Record<string, unknown>): string => {
        const hash = skillHash(ws, skill);
        if (input["hash"] !== hash) {
          throw new Error(`${skill.manifest.name} changed after the owner was asked, so that yes is not to this code. Run skills.promote again to test it and ask anew.`);
        }
        return hash;
      };
      /** On the card, and asked every time: no Auto and no remembered decision keeps code to run. */
      const keepAsk = (verb: string) => ({
        floor: "risky" as const,
        asksAlways: true,
        // Instructions are kept, never run: they need no jail.
        refuse: (input: Record<string, unknown>) => (named(input)?.manifest.kind === "prompt" ? false : noJail()),
        why: (input: Record<string, unknown>) => {
          const skill = named(input);
          if (skill?.manifest.kind === "prompt") return `${verb} ${skill.manifest.name}'s instructions as they are, to be followed as yours from now on`;
          return skill ? `${verb} ${skill.manifest.name}, code of KOS's own writing, to run without asking from now on` : "code of KOS's own writing would be kept to run";
        },
        // The hash of the files the owner is shown, set by the harness before it asks.
        stamp: (input: Record<string, unknown>) => {
          const skill = named(input);
          const hash = skill ? hashNow(skill) : undefined;
          return hash ? { ...input, hash } : input;
        },
      });

      ctx.registerTool(
        {
          name: "skills.promote",
          description:
            "Ask the owner to keep a script skill: on their yes it is tested in the sandbox and, if it passes, committed, after which skills.run runs it without asking. Any change to its files after that and it asks again.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
            required: ["name"],
          },
        },
        async (input) => {
          const skill = script(find(ws, str(input, "name")));
          const args = strings(input, "args");
          // Checked before the test: an edit while it runs leaves a hash that no longer holds, so the skill asks.
          const hash = assertAsked(skill, input);
          const outcome = await deps.promoter.promote({ entry: skill.file, ...(args ? { args } : {}) });
          if (outcome.status === "promoted") deps.markPromoted(skill.manifest.name, hash);
          return JSON.stringify(outcome);
        },
        keepAsk("tests and keeps"),
      );

      ctx.registerTool(
        {
          name: "skills.commit",
          description: "Commit a script skill as promoted, without the sandbox, or keep a prompt skill's instructions as they are, so a turn using them is not tainted by them. Asks the owner every time.",
          inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
        async (input) => {
          const skill = find(ws, str(input, "name"));
          const hash = assertAsked(skill, input);
          const sha = await deps.promoter.commit(skill.file);
          deps.markPromoted(skill.manifest.name, hash);
          return JSON.stringify({ status: "promoted", name: skill.manifest.name, sha });
        },
        keepAsk("keeps, untested,"),
      );

      ctx.registerTool(
        {
          name: "skills.run",
          description:
            "Run a script skill for real, jailed, against the live workspace. A promoted skill runs without asking, so a schedule can run it unattended (an actions job calling skills.run); one not yet promoted, or changed since, asks the owner each time. Test first with skills.test, promote with skills.promote.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
            required: ["name"],
          },
        },
        async (input) => {
          const skill = script(find(ws, str(input, "name")));
          assertOn(skill);
          // Judged as the files were when it was stamped: changed since, a yes to that code is not a yes to this. Checked again at the spawn.
          const judged = typeof input["hash"] === "string" ? input["hash"] : undefined;
          const unchanged = (): void => {
            if (judged !== undefined && judged !== skillHashNow(ws, skill)) {
              throw new Error(`${skill.manifest.name} changed after this run was judged, so it was not run. Run it again to be asked about the code as it is now.`);
            }
          };
          unchanged();
          const args = strings(input, "args");
          const result = await runSkillLive({ workspaceRoot: ws.root, entry: skill.file, verify: unchanged, ...(args ? { args } : {}), ...(deps.jail ? { jail: deps.jail } : {}) });
          return JSON.stringify(sandboxReport(result));
        },
        // Promoted once, run free: the owner's yes to the code is the yes
        // to running it, so a daily job of it costs no model turn and no ask.
        {
          floor: "risky",
          why: "runs a skill that was not promoted",
          refuse: () => noJail(),
          // The hash of the files it would run, set by the harness before it is judged: the run checks they are still those.
          stamp: (input: Record<string, unknown>) => {
            const { hash: _said, ...rest } = input;
            const skill = scriptNamed(rest);
            const hash = skill ? hashNow(skill) : undefined;
            return hash ? { ...rest, hash } : rest;
          },
          relax: (input) => {
            const skill = scriptNamed(input);
            return skill !== undefined && !off().has(skill.manifest.name) && isPromoted(skill);
          },
        },
      );
    },
  };
}
