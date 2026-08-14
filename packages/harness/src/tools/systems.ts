import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { migrationEscalation } from "../risk/rules.js";
import type { ChangeSpec } from "../systems/migrate.js";
import type { CreateProjectInput } from "../systems/manifest.js";

/**
 * Systems tools: project creation, guarded migrate, and page-spec write/list.
 * These are the primitives the agent uses to build structured projects instead
 * of inventing raw DDL or React.
 */

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

function defineSystemsTools(ctx: ModuleContext): void {
  const services = requireServices(ctx);
  const { manifest, migrator, pages } = services;
  if (!manifest || !migrator || !pages) {
    throw new Error("systems module requires manifest, migrator, and pages services");
  }

  ctx.registerTool(
    {
      name: "systems.project_create",
      description:
        "Create a project in the manifest. Returns the project (name, slug, type, status). Use systems.migrate next to add tables.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", description: "e.g. tracker, notes, budget" },
          description: { type: "string" },
          module: {
            type: "string",
            description: "Optional module blueprint this is an instance of",
          },
          instancing: { type: "string", enum: ["single", "multi"] },
        },
        required: ["name", "type"],
      },
    },
    (input) => {
      const body: CreateProjectInput = {
        name: str(input, "name"),
        type: str(input, "type"),
      };
      if (typeof input.description === "string") body.description = input.description;
      if (typeof input.module === "string") body.module = input.module;
      if (input.instancing === "single" || input.instancing === "multi") {
        body.instancing = input.instancing;
      }
      const project = manifest.createProject(body);
      return JSON.stringify(project);
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "systems.project_list",
      description: "List projects from the manifest.",
      inputSchema: {
        type: "object",
        properties: {
          module: { type: "string" },
        },
      },
    },
    (input) => {
      if (typeof input.module === "string" && input.module) {
        return JSON.stringify(manifest.listByModule(input.module));
      }
      return JSON.stringify(manifest.list());
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "systems.migrate",
      description:
        "Apply a guarded schema change to a project. Ops: create_table, add_column, drop_column, rename_column, rename_table, create_index. Tables are namespaced to the project slug automatically. Additive ops (create_table, add_column, create_index) apply immediately; drop_column, rename_column, and rename_table need owner approval. Never use raw DDL via sql.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug" },
          spec: {
            type: "object",
            description: "changeSpec with op and fields for that op",
          },
        },
        required: ["project", "spec"],
      },
    },
    (input) => {
      const project = str(input, "project");
      const spec = input.spec as ChangeSpec;
      if (!spec || typeof spec !== "object" || typeof (spec as { op?: unknown }).op !== "string") {
        throw new Error("spec must be an object with an op field");
      }
      const record = migrator.migrate(project, spec);
      return JSON.stringify({
        id: record.id,
        version: record.version,
        op: record.op,
        sql: record.sql,
      });
    },
    // Risk is tool plus arguments: additive schema changes are safe, and
    // destructive or unclassifiable ones escalate to the approval queue.
    { floor: "safe", escalate: migrationEscalation },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "pages.write",
      description:
        "Validate and save a page-spec JSON for a project. The page becomes renderable on the dashboard. Spec needs id, title, and widgets (stat/table/chart/list/markdown/card/form).",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug" },
          spec: { type: "object" },
        },
        required: ["project", "spec"],
      },
    },
    (input) => {
      const project = str(input, "project");
      const record = pages.write(project, input.spec);
      return JSON.stringify(record);
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "pages.list",
      description: "List registered page specs, optionally for one project.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
        },
      },
    },
    (input) => {
      const project =
        typeof input.project === "string" && input.project
          ? input.project
          : undefined;
      return JSON.stringify(pages.list(project));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "pages.get",
      description: "Load one page spec by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
    (input) => {
      const got = pages.get(str(input, "id"));
      if (!got) throw new Error(`page not found: ${input.id}`);
      return JSON.stringify({ record: got.record, spec: got.spec });
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );
}

export const systemsModule: KosModule = {
  manifest: {
    name: "systems",
    version: "1.0.0",
    provides: [
      { kind: "tool", name: "systems.project_create", version: "1.0.0" },
      { kind: "tool", name: "systems.project_list", version: "1.0.0" },
      { kind: "tool", name: "systems.migrate", version: "1.0.0" },
      { kind: "tool", name: "pages.write", version: "1.0.0" },
      { kind: "tool", name: "pages.list", version: "1.0.0" },
      { kind: "tool", name: "pages.get", version: "1.0.0" },
    ],
    riskTier: "risky",
  },
  activate(ctx) {
    defineSystemsTools(ctx);
  },
};
