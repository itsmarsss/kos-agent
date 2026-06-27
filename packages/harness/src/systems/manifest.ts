import type { Db } from "../store/db.js";
import { assertIdentifier, projectTable, slugify } from "./identifiers.js";

export type ProjectStatus = "born" | "active" | "dormant" | "done" | "archived";

/** How many instances a module/blueprint may have. */
export type Instancing = "single" | "multi";

export interface Project {
  id: number;
  name: string;
  slug: string;
  type: string;
  status: ProjectStatus;
  description: string | null;
  /**
   * The module (blueprint) this project is an instance of, or null for an
   * embedded/ad-hoc project not tied to a packaged module. A multi-instance
   * module has many rows here; a single-instance module has at most one.
   */
  module: string | null;
  createdAt: number;
  lastTouchedAt: number;
}

export interface CreateProjectInput {
  name: string;
  type: string;
  description?: string;
  status?: ProjectStatus;
  /** Module this is an instance of (omit for embedded/ad-hoc). */
  module?: string;
  /** Enforced when `module` is set; defaults to "multi". */
  instancing?: Instancing;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS manifest (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  module TEXT,
  created_at INTEGER NOT NULL,
  last_touched_at INTEGER NOT NULL
);
`;

interface Row {
  id: number;
  name: string;
  slug: string;
  type: string;
  status: string;
  description: string | null;
  module: string | null;
  created_at: number;
  last_touched_at: number;
}

function toProject(row: Row): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status as ProjectStatus,
    description: row.description,
    module: row.module,
    createdAt: row.created_at,
    lastTouchedAt: row.last_touched_at,
  };
}

/**
 * The manifest: the SQLite source of truth for every project. Only the
 * project-level primitives here mutate it, so it cannot drift. Project tables
 * are namespaced by the project slug (e.g. budget_tx) via projectTable.
 */
export class ProjectManifest {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  createProject(input: CreateProjectInput): Project {
    // Enforce single-instance modules: at most one instance per blueprint.
    if (input.module && (input.instancing ?? "multi") === "single") {
      if (this.listByModule(input.module).length > 0) {
        throw new Error(
          `module "${input.module}" is single-instance and already has an instance`,
        );
      }
    }
    const slug = this.uniqueSlug(slugify(input.name));
    assertIdentifier(slug, "project slug");
    const ts = this.now();
    const status: ProjectStatus = input.status ?? "active";
    const info = this.db
      .prepare(
        `INSERT INTO manifest (name, slug, type, status, description, module, created_at, last_touched_at)
         VALUES (@name, @slug, @type, @status, @description, @module, @ts, @ts)`,
      )
      .run({
        name: input.name,
        slug,
        type: input.type,
        status,
        description: input.description ?? null,
        module: input.module ?? null,
        ts,
      });
    return this.get(slug) ?? this.byId(Number(info.lastInsertRowid));
  }

  /** All instances of a given module (blueprint). */
  listByModule(module: string): Project[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM manifest WHERE module = ? ORDER BY last_touched_at DESC`,
      )
      .all(module) as Row[];
    return rows.map(toProject);
  }

  get(slug: string): Project | undefined {
    const row = this.db
      .prepare(`SELECT * FROM manifest WHERE slug = ?`)
      .get(slug) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  list(status?: ProjectStatus): Project[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT * FROM manifest WHERE status = ? ORDER BY last_touched_at DESC`,
            )
            .all(status)
        : this.db
            .prepare(`SELECT * FROM manifest ORDER BY last_touched_at DESC`)
            .all()
    ) as Row[];
    return rows.map(toProject);
  }

  /** Bump last-touched, the freshness signal retrieval weights active over cold. */
  touchProject(slug: string): void {
    this.db
      .prepare(`UPDATE manifest SET last_touched_at = ? WHERE slug = ?`)
      .run(this.now(), slug);
  }

  setStatus(slug: string, status: ProjectStatus): void {
    this.db
      .prepare(`UPDATE manifest SET status = ?, last_touched_at = ? WHERE slug = ?`)
      .run(status, this.now(), slug);
  }

  /** Namespaced physical table name for one of this project's tables. */
  tableName(slug: string, table: string): string {
    return projectTable(slug, table);
  }

  private byId(id: number): Project {
    const row = this.db
      .prepare(`SELECT * FROM manifest WHERE id = ?`)
      .get(id) as Row;
    return toProject(row);
  }

  private uniqueSlug(base: string): string {
    let slug = base;
    let n = 2;
    while (this.get(slug)) {
      slug = `${base}_${n}`;
      n += 1;
    }
    return slug;
  }
}
