import Database from "better-sqlite3";

export type { Database as Db } from "better-sqlite3";

/**
 * Open the workspace SQLite database. WAL mode pairs with the serial work
 * queue for fast single-writer access; foreign keys are enforced so the
 * schema can rely on them.
 */
export function openDatabase(path: string, scrubOf?: () => Scrub | undefined): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return scrubOf ? scrubbing(db, scrubOf) : db;
}

/** What text bound for the database passes through: secret values out, nothing else touched. */
export type Scrub = (text: string) => string;

/** The statement methods that take bind parameters. */
const BINDS = new Set<PropertyKey>(["run", "get", "all", "iterate", "bind"]);

/** A bind parameter with its strings scrubbed: positional values, arrays and named-parameter objects; a Buffer or number as it is. */
function scrubParam(value: unknown, scrub: Scrub): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v: unknown) => scrubParam(v, scrub));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubParam(v, scrub)]));
  }
  return value;
}

/** A method of `target` called on it, its result the proxy wherever it would have been the target itself (a chained `pluck()`). */
function forward(target: object, proxy: object, value: (...args: unknown[]) => unknown, args: unknown[]): unknown {
  const out = value.apply(target, args);
  return out === target ? proxy : out;
}

/**
 * The database with every string a statement binds scrubbed first, so a
 * secret's value that reached a row's text by any path (a message, a tool
 * result, a memory) is masked before SQLite stores it: the workspace is
 * snapshotted to git, where a leak would stay. Raw `exec` SQL is not bound
 * and not scrubbed; nothing puts a value there.
 */
function scrubbing(db: Database.Database, scrubOf: () => Scrub | undefined): Database.Database {
  const statement = (stmt: Database.Statement): Database.Statement => {
    const proxy: Database.Statement = new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const scrub = BINDS.has(prop) ? scrubOf() : undefined;
          return forward(target, proxy, value as (...a: unknown[]) => unknown, scrub ? args.map((a) => scrubParam(a, scrub)) : args);
        };
      },
    });
    return proxy;
  };
  // The class's own prepare, so a stand-in set on the handle (a test's spy) that calls back through the proxy does not loop.
  const prepare = Database.prototype.prepare;
  const proxy: Database.Database = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "prepare") return Object.hasOwn(target, "prepare") ? value : (source: string) => statement(prepare.call(target, source));
      return (...args: unknown[]) => forward(target, proxy, value as (...a: unknown[]) => unknown, args);
    },
  });
  return proxy;
}

/**
 * Open a second, read-only handle on the same workspace database. Display
 * queries run through this so a write is refused by SQLite itself (SQLITE_
 * READONLY) rather than by pattern-matching the SQL, which is defence a
 * cleverly-worded statement can talk its way past.
 *
 * The file must already exist: a read-only handle cannot create it.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}
