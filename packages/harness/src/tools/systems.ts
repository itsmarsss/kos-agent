import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { migrationEscalation } from "../risk/rules.js";
import { parseChangeSpec } from "../systems/migrate.js";
import { deleteProject } from "../systems/remove.js";
import type { CreateProjectInput } from "../systems/manifest.js";

/**
 * Systems tools: project creation, guarded migrate, and pages. These are the
 * primitives the agent uses to build structured projects instead of inventing
 * raw DDL; a page is HTML it writes, reaching data only through window.kos.
 */

/**
 * How to write a page, as the agent reads it in pages.write: the way a Claude
 * artifact is written, against what KOS gives a page and nothing else.
 */
const PAGE_GUIDE = [
  "Save a page for a project: one self-contained HTML document, like a Claude artifact. It shows on the dashboard in a sandboxed frame, live, and every save keeps the old one as a version (pages.history, pages.rollback).",
  "project is the project whose data the page shows. If nothing existing covers it, call systems.project_create first; never file a page under an unrelated project because it exists.",
  "Looks like KOS for free, light and dark: the frame sets KOS's tokens as CSS variables (--bg --panel --panel-2 --line --text --muted --faint --accent --ok --warn --danger, --r-sm --r-md, --text-sm --text-md --text-lg --text-xl --text-2xl, --mono) and styles plain markup: h1-h3, tables, inputs, buttons. Classes: .card (with .card-head .card-title), .grid (tiles that wrap), .row, .stack, .stat (.stat-value .stat-label), .btn (.btn--primary .btn--ghost .btn--danger), .pill (.pill--ok .pill--warn .pill--danger .pill--accent), .tag, .label, .hint, .empty, .table-wrap. Use the variables for any colour you add, so the page follows the theme.",
  "Data, through window.kos (every call is a promise):",
  "- kos.query(sql, params?) -> { rows, truncated }: a read-only SELECT over this project's own tables, at most 500 rows and 2 s. Use ? placeholders for values. Name the PHYSICAL tables systems.migrate reported.",
  "- kos.write(table, op, values, key?): op is insert, update or delete; key is { column, value } for update and delete. Only tables and columns declared in capabilities.writes.",
  "- kos.files.read(path) -> { text }: a text file inside the project's folder, when capabilities.files is true.",
  "- kos.ask(text): offer a message to the project's chat; the owner confirms it. Needs capabilities.ask.",
  "- kos.theme is 'light' or 'dark'; kos.onTheme(fn) hears a change. kos.refresh(fn) registers what to run again after the page's own writes.",
  "Query at load and after each write, so the page shows what is in the tables now; never paste the data in. If the owner puts data in (a log, a tracker), give the page a form or buttons that call kos.write, and declare that table in capabilities.writes.",
  "The page stays where it is: no <form> (Chrome never submits one in this frame; use inputs and a button whose click calls kos.write), no <link>, <meta http-equiv>, <iframe>, <object> or <base>, no link targets or downloads, no location, window.open or submit(). pages.write refuses a page that has any of these, and the frame stops them at run time.",
  "No network: no fetch, no CDN, no external image, font or stylesheet; they are blocked. Draw with SVG, canvas or CSS. libraries: ['react'] gives window.React, window.ReactDOM (createRoot) and h = React.createElement (no JSX, there is no build step); ['charts'] gives KosCharts.bar(el, { labels, values }), KosCharts.line(el, { labels, values }) and KosCharts.pie(el, { labels, values }), drawn in the theme.",
  "It must work from 390 px wide: let things wrap (.grid, .row, flex-wrap), no fixed widths, wide tables inside .table-wrap. The page fills the view and scrolls itself. If it reads the keyboard, call preventDefault on the keys it uses. Write a closing script tag plainly as </script>.",
  "headline: { label, query } gives the project's card on Home a figure: a SELECT returning one value.",
  "A page that throws shows the error with a button that asks you to fix it; read it back with pages.get first.",
  "spec: the older JSON widget page, still accepted for pages already written that way. Prefer html.",
].join("\n");

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
      name: "systems.project_delete",
      description:
        "Permanently delete a project: drop its tables, delete its pages and files, and remove it from the manifest. This destroys the project's data and cannot be undone. To set a project aside reversibly instead, leave it and change its status to archived. Owner approval is required.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug" },
        },
        required: ["project"],
      },
    },
    (input) => {
      const slug = str(input, "project");
      return JSON.stringify(deleteProject({ manifest, migrator, pages }, slug));
    },
    { floor: "risky", why: "deletes the project and its tables for good" },
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
    { floor: "safe", escalate: (input) => (migrationEscalation(input) ? "a schema change that is not an add" : false) },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "pages.write",
      description: PAGE_GUIDE,
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug: the project whose data the page shows" },
          id: { type: "string", description: "page id: letters, digits, _ or -; writing an existing id replaces that page and keeps the old one as a version" },
          title: { type: "string" },
          html: { type: "string", description: "the whole page: an HTML document or just its body" },
          capabilities: {
            type: "object",
            description: "what the page may reach through window.kos",
            properties: {
              query: { type: "boolean", description: "read-only queries of this project's tables; on unless false" },
              writes: {
                type: "array",
                description: "tables the page may change: each { table, columns, allow? } with the PHYSICAL table name; allow is any of insert, update, delete (default insert, update)",
                items: { type: "object" },
              },
              files: { type: "boolean", description: "read text files inside the project's folder" },
              ask: { type: "boolean", description: "offer a message to the project's chat; the owner confirms each one" },
            },
          },
          libraries: { type: "array", items: { type: "string", enum: ["react", "charts"] } },
          headline: { type: "object", description: "the figure for the project's card on Home: { label, query } with a single read-only SELECT returning one value" },
          spec: { type: "object", description: "the older JSON widget spec, kept for pages written that way; prefer html" },
        },
        required: ["project"],
      },
    },
    (input) => {
      const project = str(input, "project");
      if (input.spec !== undefined && input.html === undefined) return JSON.stringify(pages.write(project, input.spec));
      const { project: _project, spec: _spec, ...page } = input;
      return JSON.stringify(pages.writeHtml(project, page));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "pages.list",
      description: "List the dashboard pages, optionally for one project: each with its kind (html, or an older spec).",
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
      description: "Load one page by id: an HTML page with its declarations, or an older spec. Read a page before changing it.",
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
      return JSON.stringify(got.kind === "html" ? { record: got.record, page: got.page } : { record: got.record, spec: got.spec });
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "pages.history",
      description: "List the kept versions of a page, oldest first; the last is what shows now.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    (input) => JSON.stringify(pages.history(str(input, "id"))),
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "pages.rollback",
      description: "Put a page back as it was at one of its versions (pages.history). The rollback is itself kept as a version, so it can be undone.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "number" } }, required: ["id", "version"] },
    },
    (input) => JSON.stringify(pages.rollback(str(input, "id"), Number(input.version))),
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
      { kind: "tool", name: "systems.project_delete", version: "1.0.0" },
      { kind: "tool", name: "systems.project_list", version: "1.0.0" },
      { kind: "tool", name: "systems.migrate", version: "1.0.0" },
      { kind: "tool", name: "pages.write", version: "1.0.0" },
      { kind: "tool", name: "pages.list", version: "1.0.0" },
      { kind: "tool", name: "pages.get", version: "1.0.0" },
      { kind: "tool", name: "pages.history", version: "1.0.0" },
      { kind: "tool", name: "pages.rollback", version: "1.0.0" },
    ],
    riskTier: "risky",
  },
  activate(ctx) {
    defineSystemsTools(ctx);
  },
};
