import { foldName, placePath, type FileHome } from "@kos/shared";

import type { AuditEntry } from "./audit.js";
import type { Db } from "../store/db.js";
import { hostOf, isSqlWrite, programOf, writtenTables } from "../risk/rules.js";
import { parseMentions } from "../kernel/mentions.js";
import { placeOnDisk } from "../tools/home.js";
import { parseTarget } from "../tools/notify.js";

/**
 * Decisions the owner has made before, kept.
 *
 * Measured on a real workspace: 96 of 97 approvals granted, files.rm alone
 * asked 25 times. A gate the owner always opens is friction, not safety. So
 * a decision can be remembered: approve once and say so, and the same shape
 * stops asking. Shape, not tool: `files.rm` under one directory, `sql` writes
 * to one table, `http.fetch` to one host. A new shape still asks.
 *
 * A rule is bound to the project it was made in, or to everywhere when it
 * was made at the root. The model never writes one; only a decision does.
 * Every rule is listed in Settings and can be revoked there.
 */

export interface PermissionRule {
  id: number;
  tool: string;
  /** `dir:<prefix>`, `file:<root-level file>`, `host:<name>`, `table:<name>`, or null for tool-wide. */
  scope: string | null;
  /** The project slug it applies in, or null for everywhere. */
  project: string | null;
  /** The scheduled job whose runs it covers, alone: the job's consent, learned from the owner's yes to it. Null for a standing rule. */
  job: number | null;
  createdAt: number;
  /** False for a rule kept by an older build that no call can match any more: shown so in Settings. */
  matches: boolean;
}

/** A directory scope as calls are named: no leading ./ or /, no trailing /. */
function cleanDir(path: string): string {
  return path.replace(/^(\.?\/)+/, "").replace(/\/+$/, "");
}

/**
 * Whether any call could match a kept rule. A rule for the workspace's root
 * (`dir:`), a directory spelled as calls never name one (`dir:./x`), or a
 * yes to skills.commit, which asks every time, matches nothing.
 */
export function ruleMatches(rule: { tool: string; scope: string | null }): boolean {
  if (rule.tool === "skills.commit") return false;
  if (rule.scope?.startsWith("dir:")) {
    const dir = rule.scope.slice(4);
    return dir !== "" && cleanDir(dir) === dir;
  }
  return true;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS permission_rules (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  scope TEXT,
  project TEXT,
  created_at INTEGER NOT NULL
);
`;

/** How long the owner's yes holds for the same step in the same chat: a burst of one kind of work asks once. */
export const BURST_MS = 15 * 60_000;

/** A rule as it is kept: a job's own, or a standing one (job null). */
export type RuleInput = { tool: string; scope: string | null; project: string | null; job?: number | null };

/** Who is calling, for the decisions that are not standing rules: a yes given a moment ago in this chat, a job's consent. */
export interface Caller {
  conversationId?: string;
  /** The scheduled job whose run this is, and when it was made: a rule learned for a job before this one had its id covers nothing. */
  job?: { id: number; since: number };
}

/** A yes the owner gave a moment ago, held for the same step in the same chat. */
interface Burst {
  tool: string;
  scope: string | null;
  until: number;
}

function parentDir(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i === -1 ? "" : norm.slice(0, i);
}

/**
 * What a call's scope is, in the terms a rule is written in.
 *
 * Null means the tool is the whole scope: approving it once approves it
 * everywhere it is called the same way. Undefined means the call has a scope
 * this cannot name (a sql write whose table it cannot read), so no rule can
 * match it and it always asks.
 */
/**
 * What the caller knows that the call's arguments do not.
 *
 * A browser action names an element, not a site: the site is wherever the
 * caller's tab is. So the kernel says which tools are the browser's and
 * where that tab is, and a decision about them is kept per site, for the
 * whole family of actions, since "yes, click there" and "yes, type there"
 * are one trust. A few tools stay outside it (running script in the page)
 * and ask every time.
 */
export interface PermissionContext {
  browser?: {
    /** The browser's tool-name prefix, "browser.". */
    prefix: string;
    /** The host of the caller's tab, when it has one. */
    site?: string;
    /** Tools of the family that are never remembered. */
    strict?: string[];
    /**
     * The tab is in the owner's own Chrome, signed in as them: trusted apart
     * from KOS's Chrome, so a site trusted there is not trusted here.
     */
    yours?: boolean;
  };
  /**
   * The calling turn's home folder and the workspace root on disk: a file
   * tool's path is named by where it lands, so "notes/x" from a project and
   * "workspace:notes/x" are told apart, and two spellings of one place are
   * one scope.
   */
  home?: FileHome;
  root?: string;
  /** The call reaches beyond the turn's own folder (its reach rule fired): no rule made inside the home covers it, and none is made from it. */
  reached?: boolean;
}

/** The paths a file tool's call names. */
function filePaths(input: Record<string, unknown>): string[] {
  return ["path", "from", "to"].map((k) => input[k]).filter((v): v is string => typeof v === "string");
}

/** A file tool's path, as it lands from the turn's home and as the disk names it. */
function placed(path: string, context?: PermissionContext): string {
  if (!context?.home) return path;
  return context.root ? placeOnDisk(context.root, context.home, path).path : foldName(placePath(context.home, path).path);
}

/** True when the call reaches past the turn's own folder: said by its reach rule, or a file path landing outside. */
function reaches(tool: string, input: Record<string, unknown>, context?: PermissionContext): boolean {
  if (context?.reached) return true;
  const home = context?.home;
  return home !== undefined && tool.startsWith("files.") && filePaths(input).some((p) => (context?.root ? placeOnDisk(context.root, home, p) : placePath(home, p)).outside);
}

function browserTool(tool: string, context?: PermissionContext): boolean {
  const browser = context?.browser;
  return browser !== undefined && tool.startsWith(browser.prefix);
}

/**
 * A browser action in the owner's own Chrome that a chat they set to act
 * without asking may take: clicking, typing, going somewhere. Never one of
 * the strict tools, which ask every time however the chat is set.
 */
export function actsInYourChrome(tool: string, context?: PermissionContext): boolean {
  const browser = context?.browser;
  return browserTool(tool, context) && browser?.yours === true && !browser.strict?.includes(tool);
}

/** The name a rule is kept under: a browser action's whole family, else the tool itself. */
export function familyOf(tool: string, context?: PermissionContext): string {
  return browserTool(tool, context) ? `${context!.browser!.prefix}*` : tool;
}

export function scopeOf(tool: string, input: Record<string, unknown>, context?: PermissionContext): string | null | undefined {
  if (browserTool(tool, context)) {
    const browser = context!.browser!;
    if (browser.strict?.includes(tool)) return undefined;
    return browser.site ? `${browser.yours ? "your-chrome" : "site"}:${browser.site}` : undefined;
  }
  if (tool.startsWith("files.")) {
    const raw = typeof input["path"] === "string" ? input["path"] : typeof input["from"] === "string" ? input["from"] : "";
    const path = placed(raw, context).replace(/\\/g, "/").replace(/^(\.?\/)+/, "").replace(/\/+$/, "");
    // The workspace's root names no rule: a yes there would cover every path in it.
    if (path === "" || path === ".") return undefined;
    // A file at the root is kept to itself, never to the root it sits in.
    const dir = parentDir(path);
    return dir ? `dir:${dir}` : `file:${path}`;
  }
  if (tool === "http.fetch") {
    const host = typeof input["url"] === "string" ? hostOf(input["url"]) : undefined;
    return host ? `host:${host}` : undefined;
  }
  if (tool === "sql") {
    const sql = typeof input["sql"] === "string" ? input["sql"] : "";
    if (!isSqlWrite(sql)) return null;
    const [table] = writtenTables(sql);
    return table ? `table:${table}` : undefined;
  }
  if (tool === "shell.run") {
    // One plain command is named by its program, as Claude Code does with
    // Bash(git:*). A chain or a pipeline is not: a remembered "git" must not
    // let "git status && rm -rf ." through on the strength of its first word.
    // A command allowed to write the whole workspace is asked about every time: no rule names it, so none is made from it.
    if (input["writes"] === "workspace") return undefined;
    const program = typeof input["command"] === "string" ? programOf(input["command"]) : undefined;
    return program ? `cmd:${program}` : undefined;
  }
  if (tool === "chats.handoff") {
    // By target, as the owner named it: a remembered yes for one project
    // must not let a brief into another.
    const to = typeof input["to"] === "string" ? input["to"].trim() : "";
    const ref = parseMentions(to)[0];
    if (ref) return `to:${ref.kind}:${ref.id}`;
    return to ? `to:${to}` : undefined;
  }
  if (tool === "notify") {
    // By destination: a remembered yes for one channel must not let a post
    // into another, or a message to a person. Sending to the owner never asks.
    try {
      const target = parseTarget(input["to"]);
      if (target.kind === "owner") return null;
      return `to:${target.surface ? `${target.surface}:` : ""}${target.kind}:${target.id}`;
    } catch {
      return undefined;
    }
  }
  // Each commit keeps different code to run: a yes to one is not a yes to
  // the next, so it is never remembered, and a rule already kept for it
  // matches nothing.
  if (tool === "skills.commit") return undefined;
  // By the skill: a yes to run one skill is not a yes to run another.
  if (tool === "skills.run") {
    const name = typeof input["name"] === "string" ? input["name"].trim() : "";
    return name ? `skill:${name}` : undefined;
  }
  if (tool === "systems.migrate") {
    const spec = input["spec"];
    const table = typeof spec === "object" && spec !== null ? (spec as { table?: unknown }).table : undefined;
    return typeof table === "string" ? `table:${table.toLowerCase()}` : undefined;
  }
  return null;
}

/** Does a rule's scope cover a call's? Prefix for directories, exact otherwise. */
export function scopeCovers(rule: string | null, call: string | null): boolean {
  if (rule === null) return true;
  if (call === null) return false;
  if (rule.startsWith("dir:") && call.startsWith("dir:")) {
    const r = rule.slice(4);
    const c = call.slice(4);
    // An empty directory is the root, which no rule covers: one kept by an older build matches nothing.
    return r !== "" && (c === r || c.startsWith(`${r}/`));
  }
  return rule === call;
}

export class PermissionStore {
  /** Yeses given a moment ago, by chat: held in memory, so a restart forgets them. */
  private readonly bursts = new Map<string, Burst[]>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    const columns = this.db.prepare(`PRAGMA table_info(permission_rules)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "job")) this.db.exec(`ALTER TABLE permission_rules ADD COLUMN job INTEGER`);
  }

  list(): PermissionRule[] {
    return (
      this.db.prepare(`SELECT * FROM permission_rules ORDER BY id`).all() as {
        id: number;
        tool: string;
        scope: string | null;
        project: string | null;
        job: number | null;
        created_at: number;
      }[]
    ).map((r) => ({ id: r.id, tool: r.tool, scope: r.scope, project: r.project, job: r.job, createdAt: r.created_at, matches: ruleMatches(r) }));
  }

  /**
   * Bring rules an older build kept to what calls now match: a rule for the
   * workspace's root (`dir:`) covered every path and now covers none, so it
   * goes; `dir:./x` and `dir:/x` are spelled `dir:x`, or go when that rule is
   * already kept. Each change is on the audit record. Run at every boot, it
   * changes nothing once done. Returns how many rules changed.
   */
  migrateScopes(audit: { record: (entry: AuditEntry) => unknown }): number {
    const rules = this.list().filter((r) => r.scope?.startsWith("dir:") && !r.matches);
    return this.db.transaction(() => {
      for (const rule of rules) {
        const dir = cleanDir(rule.scope!.slice(4));
        const to = `dir:${dir}`;
        const kept = this.list().some((r) => r.id !== rule.id && r.tool === rule.tool && r.project === rule.project && r.job === rule.job && r.scope === to);
        const result = dir === "" ? "removed: a rule for the workspace's root matches nothing" : kept ? `removed: the same rule is kept as ${to}` : `rescoped to ${to}`;
        if (dir === "" || kept) this.db.prepare(`DELETE FROM permission_rules WHERE id = ?`).run(rule.id);
        else this.db.prepare(`UPDATE permission_rules SET scope = ? WHERE id = ?`).run(to, rule.id);
        audit.record({ tool: "permissions.migrate", args: { id: rule.id, tool: rule.tool, scope: rule.scope, project: rule.project }, result, isError: false });
      }
      return rules.length;
    })();
  }

  /** Remember a decision. The same rule twice is one rule. */
  add(input: RuleInput): PermissionRule {
    const rule = { tool: input.tool, scope: input.scope, project: input.project, job: input.job ?? null };
    const existing = this.list().find(
      (r) => r.tool === rule.tool && r.scope === rule.scope && r.project === rule.project && r.job === rule.job,
    );
    if (existing) return existing;
    const info = this.db
      .prepare(`INSERT INTO permission_rules (tool, scope, project, job, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(rule.tool, rule.scope, rule.project, rule.job, this.now());
    return { id: Number(info.lastInsertRowid), ...rule, createdAt: this.now(), matches: ruleMatches(rule) };
  }

  /** A job's consent goes with the job. */
  forgetJob(job: number): number {
    return this.db.prepare(`DELETE FROM permission_rules WHERE job = ?`).run(job).changes;
  }

  revoke(id: number): boolean {
    return this.db.prepare(`DELETE FROM permission_rules WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Has the owner already said yes to this?
   *
   * A rule made in a project applies only there; one made at the root
   * applies everywhere. A call whose scope cannot be named never matches.
   */
  allows(tool: string, input: Record<string, unknown>, project?: string, context?: PermissionContext): boolean {
    const scope = scopeOf(tool, input, context);
    if (scope === undefined) return false;
    const family = familyOf(tool, context);
    // Past the turn's own folder, only a rule made at the root speaks: one made in the project was about the project.
    const inProject = !reaches(tool, input, context) && project !== undefined;
    return this.list().some(
      (r) => r.job === null && (r.tool === tool || r.tool === family) && (r.project === null || (inProject && r.project === project)) && scopeCovers(r.scope, scope),
    );
  }

  /**
   * Has the owner said yes to this for this caller, though not for good?
   *
   * A job's consent: what the owner approved for that job's runs, or
   * allowed when it was scheduled, covers its later runs and nothing else.
   * A burst: the same step, in the same chat, within BURST_MS of the yes.
   * Neither is consulted for what may never be learned (risk/learned.ts);
   * the caller judges that.
   */
  learned(tool: string, input: Record<string, unknown>, who: Caller, context?: PermissionContext): "job" | "burst" | false {
    const scope = scopeOf(tool, input, context);
    if (scope === undefined) return false;
    const family = familyOf(tool, context);
    const job = who.job;
    // A job's rule was made inside its project: past the turn's own folder it says nothing.
    if (job && !reaches(tool, input, context)) {
      const covered = this.list().some((r) => r.job === job.id && r.createdAt >= job.since && (r.tool === tool || r.tool === family) && scopeCovers(r.scope, scope));
      if (covered) return "job";
    }
    const now = this.now();
    const held = who.conversationId ? (this.bursts.get(who.conversationId) ?? []).filter((b) => b.until > now) : [];
    return held.some((b) => (b.tool === tool || b.tool === family) && scopeCovers(b.scope, scope)) ? "burst" : false;
  }

  /**
   * Hold the owner's yes to this call for the same step in the same chat,
   * for BURST_MS. False when its scope cannot be named, or names the whole
   * tool: a tool-wide yes is an Always the owner presses, never a moment's.
   */
  holdBurst(conversationId: string, tool: string, input: Record<string, unknown>, context?: PermissionContext): boolean {
    const scope = scopeOf(tool, input, context);
    if (scope === undefined || scope === null) return false;
    const now = this.now();
    const family = familyOf(tool, context);
    const kept = (this.bursts.get(conversationId) ?? []).filter((b) => b.until > now && !(b.tool === family && b.scope === scope));
    this.bursts.set(conversationId, [...kept, { tool: family, scope, until: now + BURST_MS }]);
    return true;
  }

  /** The rule a decision would make, for showing before it is kept. */
  ruleFor(tool: string, input: Record<string, unknown>, project: string | null, context?: PermissionContext): { tool: string; scope: string | null; project: string | null } | undefined {
    if (reaches(tool, input, context)) return undefined;
    const scope = scopeOf(tool, input, context);
    if (scope === undefined) return undefined;
    return { tool: familyOf(tool, context), scope, project };
  }
}
