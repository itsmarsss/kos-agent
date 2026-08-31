import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { migrationEscalation } from "../risk/rules.js";
import { parseChangeSpec } from "../systems/migrate.js";
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
        "Apply a guarded schema change to a project. This is SQLite. Tables are namespaced to the project slug automatically. Additive ops (create_table, add_column, create_index) apply immediately; drop_column, rename_column, and rename_table need owner approval. Never use raw DDL via sql.\n" +
        "spec shapes, by op:\n" +
        '  create_table: {op, table, columns: [{name, type, primaryKey?, notNull?, unique?, default?}]}\n' +
        '  add_column:   {op, table, column: {name, type, ...}}\n' +
        '  drop_column:  {op, table, column: "name"}\n' +
        '  rename_column:{op, table, from, to}\n' +
        '  rename_table: {op, from, to}\n' +
        '  create_index: {op, table, columns: ["a","b"], unique?, name?}\n' +
        "A column type must be one of TEXT, INTEGER, REAL, BLOB, NUMERIC. There is no serial, decimal, date, or varchar: use INTEGER with primaryKey for a row id, REAL for money, and TEXT holding ISO-8601 for a date.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug" },
          spec: {
            type: "object",
            description:
              'changeSpec, e.g. {"op":"create_table","table":"expenses","columns":[{"name":"id","type":"INTEGER","primaryKey":true},{"name":"spent_on","type":"TEXT"},{"name":"amount","type":"REAL"}]}',
          },
        },
        required: ["project", "spec"],
      },
    },
    (input) => {
      const project = str(input, "project");
      // Checked rather than cast: this arrives as free-form model JSON, and a
      // wrong guess has to come back as an instruction, not a TypeError.
      const spec = parseChangeSpec(input.spec);
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
        "Validate and save a page-spec JSON for a project. The page becomes renderable on the dashboard. Spec needs id, title, and widgets.\n" +
        "Widgets: stat, table, chart (line/bar/area/pie), list, markdown, card, form, custom_html.\n" +
        "Data widgets take a read-only `query`; form/list/card take a `mutate` target ({table, columns, allow?}). allow is any of insert, update, delete.\n" +
        "Both `query` and `mutate.table` name the PHYSICAL table, the namespaced one systems.migrate reported, not the logical name you asked it to create.\n" +
        "If the owner has to put data in (a log, a tracker, a list they add to), the page needs a way to add a row: pair the read-only view with a form widget, or use a list or card widget with a mutate target. A page built only from queries is read-only, and the owner has no way to fill it.\n" +
        "custom_html takes `html` and an optional `height`, and renders in a sandboxed frame WITH scripts enabled: use it for anything the fixed widgets cannot express, including interactive pages and small games.\n" +
        "Write a closing script tag plainly as </script>; do not escape the slash, that is a JavaScript-string convention and in HTML it fails to close the tag.\n" +
        "If the page reads the keyboard, call preventDefault on the keys it uses. The frame does not scroll, so an unhandled arrow key scrolls the dashboard behind it instead.\n" +
        "The frame has NO network access and cannot reach the workspace. Never link an external image, font, script or stylesheet: they will fail and can break your script. Draw with canvas or CSS, and inline any asset as a data URI. Put any data the page needs directly into the html.\n" +
        "Every widget accepts an optional `span` of quarter, third, half or full.",
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
