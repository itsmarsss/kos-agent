import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { projectTable, slugify } from "../systems/identifiers.js";

/**
 * First-party multi-instance tasks module. Blueprint = this module; each
 * "list" is a project instance with a namespaced `items` table. Tools are
 * instance-parameterized via project slug.
 */

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

function itemsTable(slug: string): string {
  return projectTable(slug, "items");
}

function ensureInstanceSchema(
  ctx: ModuleContext,
  slug: string,
): void {
  const { migrator, manifest } = requireServices(ctx);
  if (!migrator || !manifest) {
    throw new Error("tasks module requires migrator and manifest");
  }
  if (!manifest.get(slug)) {
    throw new Error(`unknown project instance: ${slug}`);
  }
  // Idempotent: create_table fails if exists — check via sqlite_master.
  const phys = itemsTable(slug);
  const { db } = requireServices(ctx);
  const exists = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(phys);
  if (exists) return;
  migrator.migrate(slug, {
    op: "create_table",
    table: "items",
    columns: [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", notNull: true },
      { name: "done", type: "INTEGER", notNull: true, default: 0 },
      { name: "created_at", type: "INTEGER", notNull: true },
    ],
  });
}

function defineTasksTools(ctx: ModuleContext): void {
  const services = requireServices(ctx);
  const { db, manifest, pages } = services;
  if (!manifest) throw new Error("tasks module requires manifest");

  ctx.registerTool(
    {
      name: "tasks.create_list",
      description:
        "Create a new tasks list (or return it if the name already exists). Returns JSON with slug — use that slug as instance for tasks.add/list/complete. Do not call create_list again for the same name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          withPage: { type: "boolean" },
        },
        required: ["name"],
      },
    },
    (input) => {
      const name = str(input, "name");
      const wantPage = input.withPage !== false;
      // Idempotent: same display name or slug returns the existing list.
      const existing = manifest
        .list()
        .find(
          (p) =>
            p.module === "tasks" &&
            (p.name.toLowerCase() === name.toLowerCase() ||
              p.slug === slugify(name)),
        );
      if (existing) {
        ensureInstanceSchema(ctx, existing.slug);
        if (wantPage && pages && pages.list(existing.slug).length === 0) {
          writeTasksPage(pages, existing.slug, existing.name);
        }
        return JSON.stringify({ ...existing, alreadyExisted: true });
      }

      const project = manifest.createProject({
        name,
        type: "tasks",
        module: "tasks",
        instancing: "multi",
        ...(typeof input.description === "string"
          ? { description: input.description }
          : {}),
      });
      ensureInstanceSchema(ctx, project.slug);
      if (wantPage && pages) {
        writeTasksPage(pages, project.slug, project.name);
      }
      return JSON.stringify(project);
    },
    { floor: "risky" },
    { tags: ["tasks", "systems"] },
  );

  ctx.registerTool(
    {
      name: "tasks.add",
      description:
        "Add a task item to an existing list. instance = project slug (e.g. tonight from create_list). Safe; no approval needed.",
      inputSchema: {
        type: "object",
        properties: {
          instance: { type: "string", description: "project slug from create_list" },
          title: { type: "string" },
        },
        required: ["instance", "title"],
      },
    },
    (input) => {
      const slug = str(input, "instance");
      ensureInstanceSchema(ctx, slug);
      const title = str(input, "title");
      const table = itemsTable(slug);
      const info = db
        .prepare(
          `INSERT INTO ${table} (title, done, created_at) VALUES (?, 0, ?)`,
        )
        .run(title, Date.now());
      manifest.touchProject(slug);
      return JSON.stringify({ id: Number(info.lastInsertRowid), title });
    },
    { floor: "safe" },
    { tags: ["tasks"] },
  );

  ctx.registerTool(
    {
      name: "tasks.list",
      description:
        "List items in a tasks instance by project slug (e.g. tonight). Safe; no approval.",
      inputSchema: {
        type: "object",
        properties: {
          instance: { type: "string" },
          includeDone: { type: "boolean" },
        },
        required: ["instance"],
      },
    },
    (input) => {
      const slug = str(input, "instance");
      ensureInstanceSchema(ctx, slug);
      const table = itemsTable(slug);
      const includeDone = input.includeDone === true;
      const rows = includeDone
        ? db.prepare(`SELECT * FROM ${table} ORDER BY done, id DESC`).all()
        : db
            .prepare(
              `SELECT * FROM ${table} WHERE done = 0 ORDER BY id DESC`,
            )
            .all();
      return JSON.stringify(rows);
    },
    { floor: "safe" },
    { tags: ["tasks"] },
  );

  ctx.registerTool(
    {
      name: "tasks.complete",
      description: "Mark a task done (or reopen if done=false).",
      inputSchema: {
        type: "object",
        properties: {
          instance: { type: "string" },
          id: { type: "number" },
          done: { type: "boolean" },
        },
        required: ["instance", "id"],
      },
    },
    (input) => {
      const slug = str(input, "instance");
      ensureInstanceSchema(ctx, slug);
      const id = Number(input.id);
      if (!Number.isInteger(id)) throw new Error("id must be an integer");
      const done = input.done === false ? 0 : 1;
      const table = itemsTable(slug);
      const info = db
        .prepare(`UPDATE ${table} SET done = ? WHERE id = ?`)
        .run(done, id);
      if (info.changes === 0) throw new Error(`task not found: ${id}`);
      manifest.touchProject(slug);
      return JSON.stringify({ id, done: done === 1 });
    },
    { floor: "safe" },
    { tags: ["tasks"] },
  );
}

function writeTasksPage(
  pages: NonNullable<ReturnType<typeof requireServices>["pages"]>,
  slug: string,
  title: string,
): void {
  const table = itemsTable(slug);
  const pageId = `tasks_${slug}`.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  pages.write(slug, {
    id: pageId,
    title,
    widgets: [
      {
        type: "stat",
        label: "Open",
        query: `SELECT COUNT(*) AS n FROM ${table} WHERE done = 0`,
      },
      {
        type: "table",
        title: "Items",
        query: `SELECT id, title, done, created_at FROM ${table} ORDER BY done ASC, id DESC`,
      },
      {
        type: "markdown",
        content: `Add items via chat: tasks.add with instance="${slug}".`,
      },
    ],
  });
}

export const tasksModule: KosModule = {
  manifest: {
    name: "tasks",
    version: "1.0.0",
    provides: [
      { kind: "tool", name: "tasks.create_list", version: "1.0.0" },
      { kind: "tool", name: "tasks.add", version: "1.0.0" },
      { kind: "tool", name: "tasks.list", version: "1.0.0" },
      { kind: "tool", name: "tasks.complete", version: "1.0.0" },
    ],
    riskTier: "safe",
  },
  activate(ctx) {
    defineTasksTools(ctx);
  },
};
