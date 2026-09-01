import { isReadOnlyQuery } from "@kos/shared";

import type { Db } from "../store/db.js";
import type {
  CreateCronInput,
  CronCondition,
  CronJob,
  CronType,
  ToolCall,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  type TEXT NOT NULL,
  query TEXT,
  condition_json TEXT,
  actions_json TEXT,
  prompt TEXT,
  project_slug TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface Row {
  id: number;
  name: string;
  schedule: string;
  type: string;
  query: string | null;
  condition_json: string | null;
  actions_json: string | null;
  prompt: string | null;
  project_slug: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toJob(row: Row): CronJob {
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    type: row.type as CronType,
    query: row.query,
    condition: row.condition_json
      ? (JSON.parse(row.condition_json) as CronCondition)
      : null,
    actions: row.actions_json
      ? (JSON.parse(row.actions_json) as ToolCall[])
      : null,
    prompt: row.prompt,
    projectSlug: row.project_slug,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Persistence for cron jobs. Jobs are data, portable and inspectable. */
export class CronStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  create(input: CreateCronInput): CronJob {
    // A job's query is the variable scope, so it must be a read. Rejecting it
    // here means a write can never be stored in that field and quietly execute
    // on every tick at 3am, long after the owner approved "a query".
    if (input.query && !isReadOnlyQuery(input.query)) {
      throw new Error("cron query must be a single read-only SELECT/WITH");
    }
    const ts = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO crons (name, schedule, type, query, condition_json, actions_json, prompt, project_slug, enabled, created_at, updated_at)
         VALUES (@name, @schedule, @type, @query, @condition, @actions, @prompt, @projectSlug, @enabled, @ts, @ts)`,
      )
      .run({
        name: input.name,
        schedule: input.schedule,
        type: input.type,
        query: input.query ?? null,
        condition: input.condition ? JSON.stringify(input.condition) : null,
        actions: input.actions ? JSON.stringify(input.actions) : null,
        prompt: input.prompt ?? null,
        projectSlug: input.projectSlug ?? null,
        enabled: input.enabled === false ? 0 : 1,
        ts,
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  /**
   * Change an existing job in place.
   *
   * The same read-only rule as create: a query is the job's variable scope,
   * and an edit is exactly as good a place to slip a write into it.
   */
  update(id: number, input: CreateCronInput): CronJob | undefined {
    if (!this.get(id)) return undefined;
    if (input.query && !isReadOnlyQuery(input.query)) {
      throw new Error("cron query must be a single read-only SELECT/WITH");
    }
    this.db
      .prepare(
        `UPDATE crons SET name = @name, schedule = @schedule, type = @type,
           query = @query, condition_json = @condition, actions_json = @actions,
           prompt = @prompt, project_slug = @projectSlug, updated_at = @ts
         WHERE id = @id`,
      )
      .run({
        id,
        name: input.name,
        schedule: input.schedule,
        type: input.type,
        query: input.query ?? null,
        condition: input.condition ? JSON.stringify(input.condition) : null,
        actions: input.actions ? JSON.stringify(input.actions) : null,
        prompt: input.prompt ?? null,
        projectSlug: input.projectSlug ?? null,
        ts: this.now(),
      });
    return this.get(id);
  }

  get(id: number): CronJob | undefined {
    const row = this.db.prepare(`SELECT * FROM crons WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? toJob(row) : undefined;
  }

  list(enabledOnly = false): CronJob[] {
    const rows = (
      enabledOnly
        ? this.db.prepare(`SELECT * FROM crons WHERE enabled = 1 ORDER BY id`).all()
        : this.db.prepare(`SELECT * FROM crons ORDER BY id`).all()
    ) as Row[];
    return rows.map(toJob);
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db
      .prepare(`UPDATE crons SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, this.now(), id);
  }

  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM crons WHERE id = ?`).run(id).changes > 0;
  }
}
