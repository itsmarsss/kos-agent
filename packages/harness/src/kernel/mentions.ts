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

export type MentionKind = "project" | "page" | "file" | "schedule";

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
    ...walkFiles(sources.workspace).map((path) => ({
      kind: "file" as const,
      id: path,
      label: path,
    })),
  ];

  return all
    .map((m) => ({ m, s: Math.max(score(m.label, q), score(m.id, q)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.m.label.length - b.m.label.length)
    .slice(0, limit)
    .map((x) => x.m);
}

/** A reference as it appears in a message: `@project:budget_tracker`. */
export function mentionToken(mention: Mention): string {
  return `@${mention.kind}:${mention.id}`;
}

/*
 * The id may contain dots but must not end on one, or a mention finishing a
 * sentence eats the full stop: "@schedule:kos.backup." resolved as the job
 * "kos.backup." and was reported as not existing.
 */
const TOKEN = /@(project|page|file|schedule):([A-Za-z0-9._/-]*[A-Za-z0-9_/-])/g;

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
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: match[1] as MentionKind, id: match[2] as string });
  }
  return out;
}
