import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidPageSpec, validateHtmlPage, validatePageSpec, type HtmlPage, type PageSpec } from "@kos/shared";

import type { CronStore } from "../cron/store.js";
import type { CreateCronInput, CronCondition, CronType, ToolCall } from "../cron/types.js";
import type { Db } from "../store/db.js";
import type { Workspace } from "../store/workspace.js";
import type { Instancing, Project, ProjectManifest } from "../systems/manifest.js";
import { buildMigrationSql, parseChangeSpec, type ChangeSpec, type Migrator } from "../systems/migrate.js";
import type { PageStore } from "../systems/pages.js";
import { MODULE_FILE, MODULE_NAME, MODULES_DIR } from "./workspace.js";

/**
 * A blueprint: a project, minus its data, as a module.
 *
 * The spec draws the line between a module (code, shareable) and an
 * instance (one use, with its own rows). KOS builds most things embedded:
 * a project with tables, pages and jobs, grown in place. Promotion takes
 * such a project and writes what made it, not what is in it, into a module
 * folder: the schema as the migrator's own ledger of changes, the pages
 * with the project's slug replaced by a token, the jobs likewise. A second
 * instance is that ledger replayed under a new slug, so the migrations
 * table stays an honest record and every table is namespaced the way the
 * migrator always names them.
 *
 * Config, in the spec's sense, is what differs between instances. Here that
 * is the instance's name and slug, which is what every table and page is
 * keyed by. Anything more personal than a name is the agent's to pull out
 * when it promotes, by editing the blueprint it was handed.
 */

export const INSTANCE_TOKEN = "{{instance}}";

export interface BlueprintJob {
  name: string;
  schedule: string;
  type: CronType;
  query?: string;
  condition?: CronCondition;
  actions?: ToolCall[];
  prompt?: string;
  task?: "reasoning" | "cheap";
}

/** A page a blueprint carries: a spec, or an HTML page marked as one. */
export type BlueprintPage = PageSpec | (HtmlPage & { kind: "html" });

const isHtml = (page: BlueprintPage): page is HtmlPage & { kind: "html" } => (page as { kind?: unknown }).kind === "html";

/** An HTML page as written, without the blueprint's marker. */
const htmlOf = ({ kind: _kind, ...page }: HtmlPage & { kind: "html" }): HtmlPage => page;

export interface Blueprint {
  /** The project type an instance is made with: tracker, notes, budget. */
  type: string;
  instancing: Instancing;
  /** The migrator's change specs, in order. Table names are logical. */
  schema: ChangeSpec[];
  /** Pages with the slug tokenized. */
  pages: BlueprintPage[];
  /** Jobs with the slug tokenized, made switched off. */
  jobs: BlueprintJob[];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace a project's table names with the token, deep: `<slug>_` only where
 * it starts a word and a name follows, so `preschool_x`, "high school" and a
 * page's own code are left as they are.
 */
export function tokenize<T>(value: T, slug: string): T {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escape(slug)}_(?=[a-z0-9_])`, "g");
  return swap(value, (s) => s.replace(re, `${INSTANCE_TOKEN}_`));
}

/**
 * The reverse: a blueprint's strings for one instance. A bare token (a
 * hand-written blueprint's job may name the instance) is the slug, except in
 * a page's HTML, where only table names were ever tokenized.
 */
export function untokenize<T>(value: T, slug: string): T {
  const named = (s: string): string => s.split(`${INSTANCE_TOKEN}_`).join(`${slug}_`);
  return swap(value, (s, key) => (key === "html" ? named(s) : named(s).split(INSTANCE_TOKEN).join(slug)));
}

function swap<T>(value: T, change: (s: string, key?: string) => string, key?: string): T {
  if (typeof value === "string") return change(value, key) as T;
  if (Array.isArray(value)) return value.map((v) => swap(v, change)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, swap(v, change, k)])) as T;
  }
  return value;
}

export function parseBlueprint(raw: unknown): Blueprint {
  if (typeof raw !== "object" || raw === null) throw new Error("blueprint is not an object");
  const b = raw as Record<string, unknown>;
  const type = typeof b["type"] === "string" && b["type"].trim() ? b["type"].trim() : "";
  if (!type) throw new Error("blueprint.type is required");
  const instancing: Instancing = b["instancing"] === "single" ? "single" : "multi";
  const schema = Array.isArray(b["schema"]) ? b["schema"].map((s) => parseChangeSpec(s)) : [];
  const pages = Array.isArray(b["pages"]) ? (b["pages"] as BlueprintPage[]) : [];
  for (const p of pages) {
    if (typeof p !== "object" || p === null || typeof p.id !== "string") throw new Error("blueprint.pages entries need an id");
  }
  const jobs = Array.isArray(b["jobs"]) ? (b["jobs"] as BlueprintJob[]) : [];
  for (const j of jobs) {
    if (typeof j !== "object" || j === null || typeof j.name !== "string" || typeof j.schedule !== "string" || typeof j.type !== "string") {
      throw new Error("blueprint.jobs entries need name, schedule and type");
    }
  }
  return { type, instancing, schema, pages, jobs };
}

export interface BlueprintSources {
  db: Db;
  manifest: ProjectManifest;
  migrator: Migrator;
  pages: PageStore;
  crons?: CronStore;
}

export interface Extracted {
  blueprint: Blueprint;
  /**
   * Tables under the slug the migrator did not make. Their shape was read
   * from the database and carried as a create_table, which keeps columns
   * and keys but not indexes or anything a PRAGMA cannot say.
   */
  derived: string[];
}

/** A create_table that would make this table again, read from its shape. */
function specFromTable(db: Db, slug: string, physical: string): ChangeSpec {
  const info = db.prepare(`PRAGMA table_info("${physical.replace(/"/g, '""')}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  return {
    op: "create_table",
    table: physical.slice(slug.length + 1),
    columns: info.map((c) => ({
      name: c.name,
      type: (c.type || "TEXT").toUpperCase(),
      ...(c.pk ? { primaryKey: true } : {}),
      ...(c.notnull && !c.pk ? { notNull: true } : {}),
      ...(literalDefault(c.dflt_value) !== undefined ? { default: literalDefault(c.dflt_value) } : {}),
    })),
  };
}

/** A PRAGMA default is SQL text; only a plain literal survives the trip. */
function literalDefault(raw: string | null): string | number | null | undefined {
  if (raw === null) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  if (raw.toUpperCase() === "NULL") return null;
  return undefined;
}

/** What made a project, with its slug tokenized. Data is left behind. */
export function extractBlueprint(src: BlueprintSources, slug: string): Extracted {
  const project = src.manifest.get(slug);
  if (!project) throw new Error(`unknown project: ${slug}`);
  const schema = src.migrator.history(slug).map((r) => r.spec);
  const made = new Set<string>();
  for (const s of schema) {
    if (s.op === "create_table") made.add(`${slug}_${s.table}`);
    if (s.op === "rename_table") {
      made.delete(`${slug}_${s.from}`);
      made.add(`${slug}_${s.to}`);
    }
  }
  const present = (
    src.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`)
      .all(`${slug.replace(/[%_]/g, "\\$&")}\\_%`) as { name: string }[]
  ).map((r) => r.name);
  const derived = present.filter((t) => !made.has(t));
  for (const t of derived) schema.push(specFromTable(src.db, slug, t));

  const pages = src.pages
    .list(slug)
    .map((r): BlueprintPage | undefined => {
      const got = src.pages.get(r.id);
      if (!got) return undefined;
      return got.kind === "spec" ? got.spec : { kind: "html", ...got.page };
    })
    .filter((s): s is BlueprintPage => s !== undefined)
    .map((s) => tokenize(s, slug));

  const jobs: BlueprintJob[] = (src.crons?.list() ?? [])
    .filter((j) => j.projectSlug === slug)
    .map((j) =>
      tokenize(
        {
          name: j.name,
          schedule: j.schedule,
          type: j.type,
          ...(j.query ? { query: j.query } : {}),
          ...(j.condition ? { condition: j.condition } : {}),
          ...(j.actions ? { actions: j.actions } : {}),
          ...(j.prompt ? { prompt: j.prompt } : {}),
          ...(j.task ? { task: j.task } : {}),
        },
        slug,
      ),
    );

  return { blueprint: { type: project.type, instancing: "multi", schema, pages, jobs }, derived };
}

/**
 * Would this blueprint apply? The ledger has to build SQL, and every page
 * has to validate once an instance's slug is put back. Checked, not run:
 * the dry run that catches a hand-edited blueprint before the owner is
 * offered an instance of it.
 */
export function checkBlueprint(bp: Blueprint): string[] {
  const errors: string[] = [];
  const probe = "probe_instance";
  for (const [i, spec] of bp.schema.entries()) {
    try {
      buildMigrationSql(probe, spec);
    } catch (err) {
      errors.push(`schema[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const page of bp.pages) {
    const concrete = untokenize(page, probe);
    if (isHtml(concrete)) {
      const problems = validateHtmlPage(htmlOf(concrete));
      if (problems.length) errors.push(`page ${page.id}: ${problems.join("; ")}`);
      continue;
    }
    const problems = validatePageSpec(concrete);
    if (problems.length || !isValidPageSpec(concrete)) errors.push(`page ${page.id}: ${problems.join("; ") || "failed validation"}`);
  }
  return errors;
}

/** Write a blueprint as a module folder. Refuses to clobber one. */
export function writeBlueprintModule(
  ws: Workspace,
  name: string,
  description: string,
  bp: Blueprint,
): { dir: string; files: string[] } {
  if (!MODULE_NAME.test(name)) throw new Error(`not a module name: ${name}`);
  const dirRel = `${MODULES_DIR}/${name}`;
  const dirAbs = ws.resolve(dirRel);
  if (existsSync(dirAbs)) throw new Error(`a module named ${name} already exists`);
  mkdirSync(dirAbs, { recursive: true });
  const manifest = { name, description, blueprint: bp };
  writeFileSync(join(dirAbs, MODULE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    join(dirAbs, "README.md"),
    [
      `# ${name}`,
      "",
      description,
      "",
      `A blueprint: ${bp.schema.length} schema change${bp.schema.length === 1 ? "" : "s"}, ${bp.pages.length} page${bp.pages.length === 1 ? "" : "s"}, ${bp.jobs.length} job${bp.jobs.length === 1 ? "" : "s"}.`,
      `An instance is a project made from it; its tables are named \`<instance>_<table>\`. The token \`${INSTANCE_TOKEN}\` in pages and jobs stands for the instance's slug.`,
      "No data: the module is code and shape only, so it can be shared.",
      "",
    ].join("\n"),
    "utf8",
  );
  return { dir: dirRel, files: [`${dirRel}/${MODULE_FILE}`, `${dirRel}/README.md`] };
}

export interface InstanceTargets {
  db: Db;
  manifest: ProjectManifest;
  migrator: Migrator;
  pages: PageStore;
  crons?: CronStore;
}

/**
 * A new project from a blueprint: the ledger replayed under its slug, the
 * pages written for it, its jobs made and left off. Jobs off because a
 * fresh instance has nothing for a job to act on and the owner should
 * choose the moment it starts acting unattended.
 */
export function instantiateBlueprint(
  dst: InstanceTargets,
  module: string,
  bp: Blueprint,
  name: string,
  description?: string,
): Project {
  // One transaction: a page that will not write leaves no half-made project
  // behind. The migrator's own transactions nest as savepoints.
  const make = dst.db.transaction((): Project => {
    const project = dst.manifest.createProject({
      name,
      type: bp.type,
      ...(description ? { description } : {}),
      module,
      instancing: bp.instancing,
    });
    for (const spec of bp.schema) dst.migrator.migrate(project.slug, spec);
    for (const page of bp.pages) {
      const concrete = untokenize(page, project.slug);
      // A page id is global, so each instance's pages carry its slug, once: an id
      // that already named the project (school_dashboard) has it from the token.
      const id = concrete.id.startsWith(`${project.slug}_`) ? concrete.id : `${project.slug}_${concrete.id}`;
      if (isHtml(concrete)) dst.pages.writeHtml(project.slug, { ...htmlOf(concrete), id });
      else dst.pages.write(project.slug, { ...concrete, id });
    }
    if (dst.crons) {
      for (const job of bp.jobs) {
        const concrete = untokenize(job, project.slug);
        const input: CreateCronInput = {
          name: `${concrete.name} (${project.slug})`,
          schedule: concrete.schedule,
          type: concrete.type,
          projectSlug: project.slug,
          enabled: false,
          ...(concrete.query ? { query: concrete.query } : {}),
          ...(concrete.condition ? { condition: concrete.condition } : {}),
          ...(concrete.actions ? { actions: concrete.actions } : {}),
          ...(concrete.prompt ? { prompt: concrete.prompt } : {}),
          ...(concrete.task ? { task: concrete.task } : {}),
        };
        dst.crons.create(input);
      }
    }
    return project;
  });
  return make();
}
