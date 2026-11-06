import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { migrationEscalation } from "../risk/rules.js";
import { parseChangeSpec } from "../systems/migrate.js";
import { deleteProject } from "../systems/remove.js";
import type { CreateProjectInput } from "../systems/manifest.js";
import { artifactGuide } from "../systems/artifactguide.js";
import { ARTIFACT_KINDS, isArtifactKind } from "@kos/shared";
import { MAINTENANCE_SLUG, reachable, type Reach } from "./fence.js";
import { reachOf } from "./sql.js";

/**
 * Systems tools: project creation, guarded migrate, and artifacts. These are
 * the primitives the agent uses to build structured projects instead of
 * inventing raw DDL; an artifact is HTML it writes, reaching data only
 * through window.kos.
 */

/**
 * The write tool's description: what it takes, and where the guide is. The
 * guide itself (artifactguide.ts) is long and read on demand, so it is not
 * in every prompt.
 */
const WRITE_DESCRIPTION = [
  "Save an artifact: one self-contained HTML document of a kind (page: an app, dashboard or tool; doc: a designed document; deck: slides; sheet: a spreadsheet). It shows on the dashboard in a sandboxed frame with no network, reaching data only through window.kos, and every save keeps the old one as a version (artifacts.history, artifacts.rollback).",
  "Read artifacts.guide({ kind }) first, every time: it says how KOS artifacts are designed, the structure each kind's runtime reads, the fonts, and what the frame refuses. Then write, check once with artifacts.check, fix what it reports in one pass, and finish.",
  "project is the project whose data it shows. Omit it for a workspace artifact that belongs to no project (a memo, a deck from notes); it then has no tables or files to read. If a project fits but does not exist, call systems.project_create first; never file an artifact under an unrelated project because it exists.",
  "title is a short specific name, not a caption; description is one sentence saying what it is for.",
].join("\n");

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

/**
 * A project's schema is changed by the chats that may fill it, under the
 * sql fence's rule: its own chats, the turn that made it, and Maintenance.
 * Anywhere else could make a table it was then refused the rows of.
 */
function refuseOutsideReach(project: string, reach: Reach): void {
  if (reach.project === MAINTENANCE_SLUG || reachable(reach).includes(project)) return;
  const name = reach.projects.find((p) => p.slug === project)?.name ?? project;
  const here = reach.project ? `This chat is ${reach.projects.find((p) => p.slug === reach.project)?.name ?? reach.project}'s` : "This chat belongs to no project";
  throw new Error(`${here}, so ${name}'s tables are not its to change. Hand the work to ${name}'s own chat with chats.handoff to @project:${project}, saying what to build and load.`);
}

/** The artifact tools: a project's orchestrator is granted them for its own project's artifacts. */
export const ARTIFACT_TOOLS = ["artifacts.write", "artifacts.list", "artifacts.get", "artifacts.history", "artifacts.rollback", "artifacts.guide", "artifacts.check"] as const;

/**
 * A project's artifacts are its own chats' to read and change, as its tables
 * are: those chats, the turn that made the project, and Maintenance. A chat
 * at the root has no project, so it reaches workspace artifacts only, which
 * belong to no project and so to any chat, and hands a project's to it.
 */
function refuseOtherProjectsPage(project: string | null, reach: Reach, what: "change" | "read" = "change"): void {
  if (project === null || reach.project === MAINTENANCE_SLUG || reachable(reach).includes(project)) return;
  const name = (slug: string): string => reach.projects.find((p) => p.slug === slug)?.name ?? slug;
  const here = reach.project ? `This chat is ${name(reach.project)}'s` : "This chat belongs to no project";
  throw new Error(`${here}, so ${name(project)}'s artifacts are not its to ${what}. Hand the work to ${name(project)}'s own chat with chats.handoff to @project:${project}.`);
}

function defineSystemsTools(ctx: ModuleContext): void {
  const services = requireServices(ctx);
  const { manifest, migrator, pages, checkArtifact } = services;
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
      const madeIn = ctx.services?.callerConversation?.();
      if (madeIn) body.madeIn = madeIn;
      const project = manifest.createProject(body);
      // The turn that makes a project may build it, its tables and its rows,
      // until the turn ends; made_in is only the record of where.
      ctx.services?.turnMade?.note(project.slug);
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
      refuseOutsideReach(project, reachOf(ctx));
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
      name: "artifacts.guide",
      description: "KOS's design guide for artifacts: how to decide the treatment, plan tokens for both themes, set type, lay out, and write copy, plus the structure the kind's runtime reads and the fonts KOS bundles. Read it before every artifacts.write.",
      inputSchema: {
        type: "object",
        properties: { kind: { type: "string", enum: [...ARTIFACT_KINDS], description: "the kind about to be written: page, doc, deck or sheet" } },
      },
    },
    (input) => artifactGuide(isArtifactKind(input.kind) ? input.kind : undefined),
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.write",
      description: WRITE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "project slug whose data it shows; omit for a workspace artifact" },
          id: { type: "string", description: "letters, digits, _ or -; writing an existing id replaces it and keeps the old one as a version" },
          kind: { type: "string", enum: [...ARTIFACT_KINDS], description: "page (default), doc, deck or sheet" },
          title: { type: "string", description: "a short specific name" },
          description: { type: "string", description: "one sentence: what it is for" },
          html: { type: "string", description: "the whole document, in the kind's structure (artifacts.guide)" },
          fonts: { type: "array", items: { type: "string" }, description: "bundled font ids (artifacts.guide lists them); the kind's defaults when omitted" },
          capabilities: {
            type: "object",
            description: "what it may reach through window.kos",
            properties: {
              query: { type: "boolean", description: "read-only queries of this project's tables; on unless false" },
              writes: {
                type: "array",
                description: "tables it may change: each { table, columns, allow? } with the PHYSICAL table name; allow is any of insert, update, delete (default insert, update)",
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
        required: ["id", "title"],
      },
    },
    (input) => {
      const project = typeof input.project === "string" && input.project ? input.project : null;
      const reach = reachOf(ctx);
      refuseOtherProjectsPage(project, reach);
      // Ids are shared across projects, and a write upserts by id: the artifact it would replace is checked too,
      // or one project could take another's by naming it as its own.
      const spec = input.spec as { id?: unknown } | undefined;
      const id = typeof input.id === "string" ? input.id : typeof spec?.id === "string" ? spec.id : undefined;
      const replaced = id ? pages.get(id) : undefined;
      if (replaced) refuseOtherProjectsPage(replaced.record.projectSlug, reach);
      if (input.spec !== undefined && input.html === undefined) {
        if (project === null) throw new Error("a widget spec page needs a project; write html instead");
        return JSON.stringify(pages.write(project, input.spec));
      }
      const { project: _project, spec: _spec, ...page } = input;
      const record = pages.writeHtml(project, page);
      return JSON.stringify({ ...record, next: checkArtifact ? `Check it once: artifacts.check({ id: "${record.id}" }).` : undefined });
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.check",
      description:
        "Render an artifact in KOS's own headless Chrome at desktop (1280 px) and phone (390 px) widths, light and dark, and report what is wrong: sideways overflow and the element causing it, text cut off by a box that hides its overflow, text drawn over other text, colours that stay the same in both themes, text below AA contrast, console errors, failed window.kos calls, regions empty at rest, formula errors, a missing visible title; with small screenshots. Check once after writing, fix everything it reports in one pass, write again, and finish: no check loops.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    async (input) => {
      if (!checkArtifact) throw new Error("this KOS cannot check artifacts: it has no Chrome to render them in");
      const id = str(input, "id");
      const page = pages.get(id);
      if (page) refuseOtherProjectsPage(page.record.projectSlug, reachOf(ctx), "read");
      return checkArtifact(id);
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.list",
      description: "List artifacts: every one, one project's, or the workspace's own (project: \"workspace\"), each with its kind (page, doc, deck, sheet), title and description.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
        },
      },
    },
    (input) => {
      const project = typeof input.project === "string" && input.project ? input.project : undefined;
      return JSON.stringify(pages.list(project === "workspace" ? null : project));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.get",
      description: "Load one artifact by id: its HTML with its kind and declarations, or an older widget spec. Read one before changing it.",
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
      if (!got) throw new Error(`artifact not found: ${input.id}`);
      refuseOtherProjectsPage(got.record.projectSlug, reachOf(ctx), "read");
      return JSON.stringify(got.kind === "html" ? { record: got.record, page: got.page } : { record: got.record, spec: got.spec });
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.history",
      description: "List the kept versions of an artifact, oldest first; the last is what shows now. The owner's own edits to a doc or sheet are versions too.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    (input) => {
      const id = str(input, "id");
      const page = pages.get(id);
      if (page) refuseOtherProjectsPage(page.record.projectSlug, reachOf(ctx), "read");
      return JSON.stringify(pages.history(id));
    },
    { floor: "safe" },
    { tags: ["systems"] },
  );

  ctx.registerTool(
    {
      name: "artifacts.rollback",
      description: "Put an artifact back as it was at one of its versions (artifacts.history). The rollback is itself kept as a version, so it can be undone.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "number" } }, required: ["id", "version"] },
    },
    (input) => {
      const id = str(input, "id");
      const page = pages.get(id);
      if (page) refuseOtherProjectsPage(page.record.projectSlug, reachOf(ctx));
      return JSON.stringify(pages.rollback(id, Number(input.version)));
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
      { kind: "tool", name: "systems.project_delete", version: "1.0.0" },
      { kind: "tool", name: "systems.project_list", version: "1.0.0" },
      { kind: "tool", name: "systems.migrate", version: "1.0.0" },
      ...ARTIFACT_TOOLS.map((name) => ({ kind: "tool" as const, name, version: "1.0.0" })),
    ],
    riskTier: "risky",
  },
  activate(ctx) {
    defineSystemsTools(ctx);
  },
};
