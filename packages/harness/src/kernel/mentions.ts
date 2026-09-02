import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { Workspace } from "../store/workspace.js";

/**
 * Things the owner can point at with @.
 *
 * One list across every kind, because when you are mid-sentence you know what
 * you mean, not which tab it lives under. The reference that goes into the
 * message is unambiguous (`@project:budget_tracker`) so the agent never has to
 * guess which of several similarly named things was meant.
 */

export type MentionKind =
  | "project"
  | "page"
  | "file"
  | "schedule"
  | "chat"
  | "site"
  | "agent";

export interface Mention {
  kind: MentionKind;
  /** Stable identifier: slug, page id, workspace-relative path, or job name. */
  id: string;
  /** What the owner sees in the list. */
  label: string;
  /** Secondary line, when there is something worth saying. */
  hint?: string;
}

export interface MentionSources {
  projects: { slug: string; name: string; type: string }[];
  pages: { id: string; title: string; projectSlug: string }[];
  crons: { name: string; schedule: string }[];
  workspace: Workspace;
  /** Conversations, so the palette can jump straight to one. */
  chats?: { id: string; title: string }[];
  /** Built sites, addressed as project/name. */
  sites?: { project: string; name: string; path: string }[];
  /**
   * Coding sub-agents, running or recently finished. Addressed by id because
   * two builds in the same folder are different agents.
   */
  agents?: { id: number; dir: string; status: string }[];
}

/**
 * Machinery rather than the owner's work.
 *
 * Anything hidden is already skipped, which covers .git, .venv and the rest.
 * These are the ones that are not hidden and would otherwise bury a picker in
 * thousands of files nobody is looking for: a Python venv alone is enough.
 */
const SKIP = new Set([
  "node_modules",
  "__pycache__",
  "site-packages",
  "venv",
  "env",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  "out",
]);
const MAX_FILES = 400;

/**
 * Walk the workspace for files worth naming. Bounded rather than exhaustive: a
 * picker is for reaching something you already have in mind, and a workspace
 * with a large project in it should not make typing @ slow.
 */
export function walkFiles(workspace: Workspace, limit = MAX_FILES): string[] {
  const out: string[] = [];
  const root = workspace.root;

  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      // Hidden first: dotfiles and dot-directories are never what someone is
      // reaching for with @, and .venv would swamp everything else.
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SKIP.has(entry.name)) continue;
      if (/\.egg-info$/.test(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };

  walk(root, 0);
  return out;
}

function score(text: string, query: string): number {
  const haystack = text.toLowerCase();
  if (!query) return 1;
  const index = haystack.indexOf(query);
  if (index < 0) return 0;
  // Earlier is better, and a prefix match beats one buried in the middle.
  return index === 0 ? 3 : 2 - Math.min(1, index / haystack.length);
}

export function findMentions(
  sources: MentionSources,
  query: string,
  limit = 12,
  /** Narrow to one kind, as when the owner has typed `@file:`. */
  kind?: MentionKind,
): Mention[] {
  const q = query.trim().toLowerCase();
  const all: Mention[] = [
    ...sources.projects.map((p) => ({
      kind: "project" as const,
      id: p.slug,
      label: p.name,
      hint: p.type,
    })),
    ...sources.pages.map((p) => ({
      kind: "page" as const,
      id: p.id,
      label: p.title,
      hint: p.projectSlug,
    })),
    ...sources.crons.map((c) => ({
      kind: "schedule" as const,
      id: c.name,
      label: c.name,
      hint: c.schedule,
    })),
    ...(sources.chats ?? []).map((c) => ({
      kind: "chat" as const,
      id: c.id,
      label: c.title,
    })),
    ...(sources.agents ?? []).map((a) => ({
      kind: "agent" as const,
      id: String(a.id),
      label: a.dir,
      hint: a.status,
    })),
    ...(sources.sites ?? []).map((s) => ({
      kind: "site" as const,
      id: `${s.project}/${s.name}`,
      label: s.name,
      hint: s.project,
    })),
    ...walkFiles(sources.workspace).map((path) => ({
      kind: "file" as const,
      id: path,
      label: path,
    })),
  ];

  return all
    .filter((m) => kind === undefined || m.kind === kind)
    .map((m) => ({ m, s: Math.max(score(m.label, q), score(m.id, q)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.m.label.length - b.m.label.length)
    .slice(0, limit)
    .map((x) => x.m);
}

/** A reference as it appears in a message: `@project:budget_tracker`. */
export function mentionToken(mention: Mention): string {
  return writeMention(mention.kind, mention.id);
}

/**
 * Write a reference to something, bracketing the id when it needs it.
 *
 * A schedule is named by the owner and usually has spaces in it. The plain
 * form allowed none, so the picker inserted "@schedule:9 AM Pinger Test" and
 * the parser read "@schedule:9": most jobs could not be pointed at at all.
 */
export function writeMention(kind: MentionKind, id: string): string {
  return PLAIN_ID.test(id) ? `@${kind}:${id}` : `@${kind}:[${id}]`;
}

/** Ids that need no brackets, matching the unbracketed half of TOKEN. */
const PLAIN_ID = /^[A-Za-z0-9._/-]*[A-Za-z0-9_/-]$/;

/*
 * The id may contain dots but must not end on one, or a mention finishing a
 * sentence eats the full stop: "@schedule:kos.backup." resolved as the job
 * "kos.backup." and was reported as not existing.
 */
const KINDS = "project|page|file|schedule|chat|site|agent";

/**
 * Either bracketed, which may hold anything but a bracket, or plain. The
 * bracketed branch is tried first so "[a b]" is not read as the plain id "".
 */
const TOKEN = new RegExp(
  `@(${KINDS}):(?:\\[([^\\]]+)\\]|([A-Za-z0-9._/-]*[A-Za-z0-9_/-]))`,
  "g",
);

/**
 * Pull the references out of a message.
 *
 * Returned in the order written and deduped, so a message naming the same file
 * twice does not have it resolved and attached twice.
 */
export function parseMentions(text: string): { kind: MentionKind; id: string }[] {
  const out: { kind: MentionKind; id: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    // Bracketed or plain, whichever branch matched.
    const id = match[2] ?? match[3];
    if (!id) continue;
    const key = `${match[1]}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: match[1] as MentionKind, id });
  }
  return out;
}
