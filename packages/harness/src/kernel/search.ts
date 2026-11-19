import {
  matchText,
  oneLine,
  queryWords,
  SEARCH_KINDS,
  snippetOf,
  summarizeAction,
  type MatchQuality,
  type SearchHit,
  type SearchKind,
  type SearchResults,
} from "@kos/shared";

import { GLOBAL_SCOPE, type Fact } from "../memory/facts.js";
import { listPages, PAGE_NAME, PAGES_DIR, readPage, type PageInfo } from "../memory/pages.js";
import type { AuditRecord } from "../ops/audit.js";
import type { RunRecord } from "../ops/runs.js";
import type { Workspace } from "../store/workspace.js";
import { searchContents } from "./fileinfo.js";
import type { Kernel } from "./kernel.js";
import { historyEvents, type ChatEvent } from "./transcript.js";

/**
 * Search everything, for the palette: what was said in every chat, what the
 * workspace's files hold, memory, runs and tool calls, and the names of
 * secrets. One query fans out to a source each, every source bounded by a
 * cap and all of them by one deadline; what has not answered by then is
 * named as late rather than waited for. Each source reads through the path
 * its own page already does (the Files page's contents search, the memory
 * store's recall, the vault's list), so it sees what that page may show
 * and nothing more.
 */

/** How long a search waits for its sources before it answers with what came. */
export const SEARCH_DEADLINE_MS = 800;
/** Hits one source may give. */
export const PER_SOURCE = 8;
/** Hits one answer may carry. */
export const SEARCH_LIMIT = 40;
/** Shorter than this is not searched in full text: a letter matches everything. */
export const MIN_QUERY = 2;

export interface SearchContext {
  cap: number;
  /** Epoch ms by which the source answers; a walk checks it and stops there. */
  until: number;
  /** Aborted once the deadline passes with the source still out. */
  signal: AbortSignal;
}

export interface SourceAnswer {
  hits: SearchHit[];
  /** It stopped at a bound or the deadline: there may be more. */
  truncated?: boolean;
}

export interface SearchSource {
  kind: SearchKind;
  find(query: string, ctx: SearchContext): SourceAnswer | Promise<SourceAnswer>;
}

export interface SearchOptions {
  kinds?: readonly SearchKind[];
  limit?: number;
  perSource?: number;
  deadlineMs?: number;
}

const DAY = 86_400_000;

/**
 * How good a hit is, comparable across sources: the whole query beats its
 * words apart, a hit in what a thing is called beats one in what it holds,
 * and of two equal hits the newer is a little better.
 */
export function scoreOf(quality: MatchQuality, place: "title" | "body", at: number | undefined, now = Date.now()): number {
  const base = quality === "phrase" ? (place === "title" ? 1 : 0.8) : place === "title" ? 0.6 : 0.5;
  const age = at === undefined ? Infinity : Math.max(0, now - at);
  return base + 0.1 * Math.exp(-age / (30 * DAY));
}

/** Fan a query out to the sources asked for, and rank what each found by the deadline. */
export async function searchAll(sources: readonly SearchSource[], query: string, options: SearchOptions = {}): Promise<SearchResults> {
  const q = query.trim();
  if (q.length < MIN_QUERY) return { hits: [], late: [], truncated: [] };
  const wanted = new Set(options.kinds?.length ? options.kinds : SEARCH_KINDS);
  const chosen = sources.filter((s) => wanted.has(s.kind));
  const deadline = options.deadlineMs ?? SEARCH_DEADLINE_MS;
  const stop = new AbortController();
  const ctx: SearchContext = { cap: options.perSource ?? PER_SOURCE, until: Date.now() + deadline, signal: stop.signal };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), deadline)));
  // Every source is started before any is waited on, so the slow ones (a file walk in its child) run while the quick ones answer.
  const started = chosen.map((source) => {
    let answer: Promise<SourceAnswer>;
    try {
      answer = Promise.resolve(source.find(q, ctx));
    } catch (err) {
      answer = Promise.reject(err);
    }
    // A source that fails has nothing to say; the others still answer.
    return { source, answer: answer.catch((): SourceAnswer => ({ hits: [] })) };
  });

  const hits: SearchHit[] = [];
  const lateKinds: SearchKind[] = [];
  const truncated: SearchKind[] = [];
  for (const { source, answer } of started) {
    const got = await Promise.race([answer, late]);
    if (got === "late") {
      lateKinds.push(source.kind);
      continue;
    }
    hits.push(...got.hits.slice(0, ctx.cap));
    if (got.truncated || got.hits.length > ctx.cap) truncated.push(source.kind);
  }
  clearTimeout(timer);
  stop.abort();
  hits.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0));
  return { hits: hits.slice(0, options.limit ?? SEARCH_LIMIT), late: lateKinds, truncated };
}

/** The best `cap` of what a source found, best first. */
const best = (hits: SearchHit[], cap: number): SearchHit[] => hits.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0)).slice(0, cap);

/** The longest word of a query: the one a first pass narrows by. */
const longestWord = (query: string): string => queryWords(query).reduce((a, b) => (b.length > a.length ? b : a), "");

export interface MessageSourceDeps {
  /** The owner's chats, newest first, as the dashboard lists them. */
  conversations: () => readonly { id: string; title: string; updatedAt: number }[];
  /** A chat's transcript as its view draws it, so a hit's index is the message the view shows. */
  events: (id: string) => ChatEvent[];
  /** The chats whose stored words may hold a word; undefined to read them all. */
  mentioning: (word: string) => ReadonlySet<string> | undefined;
}

/** What was said, by the owner or KOS, in every chat the dashboard lists. */
export function messageSource(deps: MessageSourceDeps): SearchSource {
  return {
    kind: "msg",
    find(query, ctx) {
      const maybe = deps.mentioning(longestWord(query));
      const hits: SearchHit[] = [];
      let truncated = false;
      for (const chat of deps.conversations()) {
        if (maybe && !maybe.has(chat.id)) continue;
        if (Date.now() > ctx.until || hits.length >= ctx.cap * 4) {
          truncated = true;
          break;
        }
        deps.events(chat.id).forEach((event, index) => {
          if (event.kind !== "message" || event.role === "system") return;
          const text = oneLine(event.text);
          const match = matchText(text, query);
          if (!match) return;
          const at = event.at ?? chat.updatedAt;
          hits.push({
            kind: "msg",
            id: `${chat.id}#${index}`,
            title: chat.title,
            hint: event.role === "you" ? "you" : "KOS",
            snippet: snippetOf(text, match.marks),
            score: scoreOf(match.quality, "body", at),
            at,
            target: { kind: "chat", id: chat.id, event: index },
          });
        });
      }
      return { hits: best(hits, ctx.cap), truncated };
    },
  };
}

/** A memory page's file, which the memory source answers for. */
const isMemoryPage = (path: string): boolean => {
  const m = new RegExp(`^${PAGES_DIR}/([^/]+)\\.md$`).exec(path);
  return m !== null && PAGE_NAME.test(m[1]!);
};

/**
 * What the workspace's text files hold: the Files page's own contents
 * search, in a lane of its own so the palette and that page never stop each
 * other. Through the jail, past the workspace's own files, .kos and every
 * hidden name, as that search goes.
 */
export function contentSource(ws: Workspace): SearchSource {
  return {
    kind: "text",
    async find(query, ctx) {
      // Answers with what it read by then, a little before the deadline, rather than being cut off with nothing.
      const budgetMs = Math.max(50, ctx.until - Date.now() - 120);
      const found = await searchContents(ws, ".", query, { lane: "palette", budgetMs, signal: ctx.signal });
      const hits = found.entries
        .filter((e) => !isMemoryPage(e.path))
        .map((e): SearchHit => {
          // Its path is the name the Files group already matched; here it is what the file holds that counts.
          return {
            kind: "text",
            id: e.path,
            title: e.path,
            hint: `line ${e.line}`,
            snippet: { text: e.text, marks: e.marks },
            score: scoreOf(matchText(e.text, query)?.quality ?? "words", "body", e.modifiedAt),
            at: e.modifiedAt,
            target: { kind: "file", path: e.path, line: e.line },
          };
        });
      return { hits: best(hits, ctx.cap), truncated: found.truncated };
    },
  };
}

export interface MemorySourceDeps {
  /** The memory store's own recall, over current claims. */
  recall: (query: string, limit: number) => Fact[];
  pages: () => PageInfo[];
  readPage: (name: string) => string | undefined;
}

/** Where a claim applies, in words. */
function scopeWords(scope: string): string {
  if (scope === GLOBAL_SCOPE) return "everywhere";
  const [kind, name] = scope.split(":", 2);
  return kind === "project" || kind === "caller" ? (name ?? scope) : scope;
}

/** Memory: the claims, by what recall finds for the query, and the pages written from them. */
export function memorySource(deps: MemorySourceDeps): SearchSource {
  return {
    kind: "memory",
    find(query, ctx) {
      const hits: SearchHit[] = [];
      for (const fact of deps.recall(query, ctx.cap)) {
        const value = oneLine(fact.value);
        const inValue = matchText(value, query);
        const inKey = matchText(fact.key, query);
        // Recall also finds a word by its stem; such a claim ranks after one that holds the word itself.
        const quality: MatchQuality = inKey?.quality ?? inValue?.quality ?? "words";
        hits.push({
          kind: "memory",
          id: `claim:${fact.id}`,
          title: fact.key,
          hint: scopeWords(fact.scope),
          snippet: snippetOf(value, inValue?.marks ?? []),
          score: scoreOf(quality, inKey ? "title" : "body", fact.updatedAt) - (inKey || inValue ? 0 : 0.2),
          at: fact.updatedAt,
          target: { kind: "claim", id: fact.id },
        });
      }
      for (const page of deps.pages()) {
        if (Date.now() > ctx.until) return { hits: best(hits, ctx.cap), truncated: true };
        const lines = (deps.readPage(page.name) ?? "").split("\n");
        const named = matchText(page.name, query);
        const at = lines.findIndex((l) => matchText(l, query));
        if (at < 0 && !named) continue;
        const line = oneLine(lines[at] ?? "");
        const match = at >= 0 ? matchText(line, query) : undefined;
        hits.push({
          kind: "memory",
          id: `page:${page.name}`,
          title: page.name,
          hint: "page",
          snippet: snippetOf(line, match?.marks ?? []),
          score: scoreOf((named ?? match)!.quality, named ? "title" : "body", page.updatedAt),
          at: page.updatedAt,
          target: { kind: "memory-page", name: page.name },
        });
      }
      return { hits: best(hits, ctx.cap) };
    },
  };
}

export interface RunSourceDeps {
  /** The latest runs, newest first. */
  runs: (limit: number) => RunRecord[];
  /** What a run was, in words (its job's name, its chat's title), read once per search. */
  labeller: () => (run: RunRecord) => string;
  /** Tool calls whose tool or arguments hold a word, newest first. */
  calls: (word: string, limit: number) => AuditRecord[];
  /** A call in words, as History shows it. */
  summary: (call: AuditRecord) => string;
}

/** A run's kind as Runs names it: a chat's turn, a scheduled job, a check, KOS's own work on memory. */
export function runWords(kind: string): string {
  if (kind === "chat") return "turn";
  if (kind === "cron") return "job";
  if (kind === "heartbeat") return "check";
  if (kind.startsWith("memory.")) return "memory";
  return kind;
}

/** How far back the runs are read: a few weeks of turns and jobs. */
const RUNS_READ = 500;

/** Runs and the History page's tool calls. */
export function runSource(deps: RunSourceDeps): SearchSource {
  return {
    kind: "run",
    find(query, ctx) {
      const hits: SearchHit[] = [];
      const labelOf = deps.labeller();
      for (const run of deps.runs(RUNS_READ)) {
        const label = labelOf(run);
        const error = oneLine(run.error ?? "");
        const named = matchText(`${label} ${run.kind}`, query);
        const failed = error ? matchText(error, query) : undefined;
        if (!named && !failed) continue;
        hits.push({
          kind: "run",
          id: `run:${run.id}`,
          title: label,
          hint: run.status === "error" ? `${runWords(run.kind)} · failed` : runWords(run.kind),
          snippet: failed ? snippetOf(error, failed.marks) : snippetOf(label, matchText(label, query)?.marks ?? []),
          score: scoreOf((named ?? failed)!.quality, named ? "title" : "body", run.startedAt),
          at: run.startedAt,
          target: { kind: "run", id: run.id },
        });
      }
      for (const call of deps.calls(longestWord(query), ctx.cap * 4)) {
        const summary = oneLine(deps.summary(call));
        const said = matchText(`${call.tool} ${summary}`, query);
        const args = oneLine(call.args);
        const inArgs = said ? undefined : matchText(args, query);
        if (!said && !inArgs) continue;
        hits.push({
          kind: "run",
          id: `call:${call.id}`,
          title: call.tool,
          ...(call.isError ? { hint: "failed" } : {}),
          snippet: inArgs ? snippetOf(args, inArgs.marks) : snippetOf(summary, matchText(summary, query)?.marks ?? []),
          score: scoreOf((said ?? inArgs)!.quality, "body", call.createdAt),
          at: call.createdAt,
          target: { kind: "call", id: call.id },
        });
      }
      return { hits: best(hits, ctx.cap) };
    },
  };
}

/** A secret as the search may know it: what it is called, never what it holds. */
export interface SecretName {
  handle: string;
  label: string;
  kind: string;
  source: "vault" | "env";
}

/** The names of secrets: the vault's while it is open, and the env file's. */
export function secretSource(names: () => SecretName[]): SearchSource {
  return {
    kind: "secret",
    find(query, ctx) {
      const hits = names().flatMap((s): SearchHit[] => {
        const label = matchText(s.label, query);
        const match = label ?? matchText(s.handle, query);
        if (!match) return [];
        return [{
          kind: "secret",
          id: s.handle,
          title: s.label,
          hint: s.source === "env" ? "from env" : s.kind,
          snippet: label ? { text: s.label, marks: label.marks } : { text: s.handle, marks: match.marks },
          score: scoreOf(match.quality, "title", undefined),
          target: { kind: "secret", handle: s.handle },
        }];
      });
      return { hits: best(hits, ctx.cap) };
    },
  };
}

/** Every source over a running kernel, fenced as the owner's dashboard is. */
export function kernelSources(kernel: Kernel): SearchSource[] {
  const owner = kernel.profile.ownerId;
  const chats = (): ReturnType<Kernel["conversations"]["list"]> => kernel.conversations.list(owner);
  return [
    // First, so its child is reading while the others answer.
    contentSource(kernel.workspace),
    messageSource({
      conversations: chats,
      events: (id) => historyEvents(kernel.sessions.earlier(id), kernel.sessions.get(id), kernel.actionHome(id)),
      mentioning: (word) => kernel.sessions.mentioning(word),
    }),
    memorySource({
      recall: (query, limit) => kernel.facts.search(owner, query, limit),
      pages: () => listPages(kernel.workspace),
      readPage: (name) => readPage(kernel.workspace, name),
    }),
    runSource({
      runs: (limit) => kernel.runs.recent(limit),
      labeller: () => {
        const jobs = new Map(kernel.crons.list().map((c) => [String(c.id), c.name]));
        const titles = new Map(kernel.conversations.list(owner, { includeArchived: true }).map((c) => [c.id, c.title]));
        return (run) => {
          if (run.kind === "cron") return (run.ref && jobs.get(run.ref)) || "A job since removed";
          if (run.kind === "chat") return (run.ref && titles.get(run.ref)) || "A chat";
          return run.kind;
        };
      },
      calls: (word, limit) => kernel.audit.search(word, limit),
      summary: (call) => summarizeAction(call.tool, call.args, (kind, id) => kernel.labelFor(kind, id), kernel.actionHome(call.conversationId)),
    }),
    secretSource(() => {
      const vault = kernel.secrets.attached();
      // A shut vault lists nothing, as its own page does; the env file's names are always there.
      const own = vault && vault.status().state === "ready" ? vault.list().map((m): SecretName => ({ handle: m.handle, label: m.label, kind: m.kind, source: "vault" })) : [];
      return [...own, ...kernel.secrets.envNames().map((name): SecretName => ({ handle: name, label: name, kind: "apikey", source: "env" }))];
    }),
  ];
}
