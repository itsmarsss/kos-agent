import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { checkBlueprint, extractBlueprint, instantiateBlueprint, writeBlueprintModule } from "../modules/blueprint.js";
import { MODULE_FILE, MODULES_DIR, readWorkspaceModules, scaffoldModule } from "../modules/workspace.js";
import type { McpStatus } from "./mcp.js";

/**
 * The `modules` tools: what modules the workspace holds, and making a new one.
 *
 * Making one is writing a folder, which is safe: nothing runs until the
 * owner switches the module on in Settings. There is no tool for that on
 * purpose. The agent can build a feature; the owner decides it runs.
 */

export interface ModulesModuleDeps {
  /** Names the owner has switched on, read fresh. */
  enabled: () => string[];
  /** What the MCP module has up right now, by server name. */
  status: () => McpStatus;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} is required`);
  return v.trim();
}

export function createModulesModule(deps: ModulesModuleDeps): KosModule {
  return {
    manifest: {
      name: "modules",
      version: "1.0.0",
      provides: [
        { kind: "tool", name: "modules.list", version: "1.0.0" },
        { kind: "tool", name: "modules.create", version: "1.0.0" },
        { kind: "tool", name: "modules.promote", version: "1.0.0" },
        { kind: "tool", name: "modules.instantiate", version: "1.0.0" },
      ],
      riskTier: "risky",
    },
    activate(ctx: ModuleContext) {
      const services = requireServices(ctx);
      const ws = services.workspace;
      const sources = () => {
        const { manifest, migrator, pages, crons } = services;
        if (!manifest || !migrator || !pages) throw new Error("blueprints need the manifest, migrator and pages services");
        return { db: services.db, manifest, migrator, pages, ...(crons ? { crons } : {}) };
      };

      ctx.registerTool(
        {
          name: "modules.list",
          description:
            `Every module in the workspace (a folder under ${MODULES_DIR}/ with a ${MODULE_FILE}): name, description, whether the owner has it on, and the tools it is serving. Also names any that could not be read and why.`,
          inputSchema: { type: "object", properties: {} },
        },
        () => {
          const { modules, invalid } = readWorkspaceModules(ws);
          const on = new Set(deps.enabled());
          const status = deps.status();
          return JSON.stringify({
            modules: modules.map((m) => ({
              ...m.manifest,
              dir: m.dir,
              enabled: on.has(m.manifest.name),
              ...(status[m.manifest.name]
                ? { connected: status[m.manifest.name]!.connected, serving: status[m.manifest.name]!.tools, ...(status[m.manifest.name]!.error ? { error: status[m.manifest.name]!.error } : {}) }
                : {}),
            })),
            invalid,
          });
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "modules.create",
          description:
            "Start a new module: a folder with its manifest and a small server that already speaks the protocol, with one example tool to replace. Edit server.mjs to add tools and module.json to floor them, then ask the owner to switch the module on in Settings; nothing runs before that.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "lowercase, digits, - and _ only" },
              description: { type: "string", description: "one sentence: what it does" },
            },
            required: ["name", "description"],
          },
        },
        (input) => {
          const made = scaffoldModule(ws, str(input, "name"), str(input, "description"));
          return JSON.stringify({ created: made.dir, files: made.files, next: "edit server.mjs and module.json, then ask the owner to enable it in Settings > Modules" });
        },
        { floor: "safe" },
      );

      ctx.registerTool(
        {
          name: "modules.promote",
          description:
            "Package a project as a blueprint module: its schema (the migrator's ledger), its pages and its jobs, with the project's slug replaced by a token, and none of its data. The project becomes the blueprint's first instance; more can be made with modules.instantiate or from Settings > Modules. Only on the owner's explicit yes: suggest it, never do it unasked.",
          inputSchema: {
            type: "object",
            properties: {
              project: { type: "string", description: "project slug" },
              name: { type: "string", description: "module name: lowercase, digits, - and _ only; defaults to the slug" },
              description: { type: "string", description: "one sentence: what an instance of it is for" },
            },
            required: ["project", "description"],
          },
        },
        (input) => {
          const src = sources();
          const slug = str(input, "project");
          const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : slug.replace(/_/g, "-");
          const { blueprint, derived } = extractBlueprint(src, slug);
          const problems = checkBlueprint(blueprint);
          if (problems.length) throw new Error(`the blueprint would not apply: ${problems.join("; ")}`);
          const made = writeBlueprintModule(ws, name, str(input, "description"), blueprint);
          src.manifest.setModule(slug, name);
          return JSON.stringify({
            promoted: slug,
            module: name,
            dir: made.dir,
            schema: blueprint.schema.length,
            pages: blueprint.pages.length,
            jobs: blueprint.jobs.length,
            ...(derived.length ? { derived, note: "these tables were not made through systems.migrate; their columns were read from the database, their indexes were not" } : {}),
          });
        },
        // The owner's yes, as the spec requires: the floor puts it through approval.
        { floor: "risky" },
      );

      ctx.registerTool(
        {
          name: "modules.instantiate",
          description:
            "Make a new project from a blueprint module: its tables under the new slug, its pages, its jobs (left off). Additive only.",
          inputSchema: {
            type: "object",
            properties: {
              module: { type: "string", description: "the blueprint module's name" },
              name: { type: "string", description: "the new project's name, e.g. \"Household 2026\"" },
              description: { type: "string" },
            },
            required: ["module", "name"],
          },
        },
        (input) => {
          const src = sources();
          const moduleName = str(input, "module");
          const found = readWorkspaceModules(ws).modules.find((m) => m.manifest.name === moduleName);
          if (!found?.manifest.blueprint) throw new Error(`no blueprint module named ${moduleName}`);
          const project = instantiateBlueprint(src, moduleName, found.manifest.blueprint, str(input, "name"), typeof input.description === "string" ? input.description : undefined);
          return JSON.stringify({ created: project, next: "its jobs are off; switch them on under Runs > Schedule when it has data" });
        },
        { floor: "safe" },
      );
    },
  };
}
