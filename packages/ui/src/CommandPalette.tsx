import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";
import { isSearchKind, marksOfLetters, SEARCH_KINDS, type HitKind, type SearchHit, type SearchKind, type SearchTarget, type Snippet } from "@kos/shared";
import { announce, ease, EmptyState, Marked, useFocusTrap } from "@kos/kit";

import { api } from "./api.js";
import { withParams } from "./hashparams.js";
import { hrefFor, NAV, type Route } from "./routes.js";
import { scheduleWords } from "./schedule.js";
import type { Theme } from "./theme.js";
import { SECTIONS, searchSettings } from "./settingsindex.js";

/**
 * One box that gets you anywhere.
 *
 * It used to open a chat with KOS, which is a thing you can already do from
 * Chats, so the most reachable key in the app was spent on the second way to
 * do something rather than on the only way to do a hundred things.
 *
 * Two ways to narrow, and they are the ones already used elsewhere so there is
 * nothing new to learn:
 *
 * - `project:`, `file:`, `page:`, `schedule:`, `chat:`, `site:` scope a search
 *   to one kind, the same prefixes the composer's @ menu uses; `msg:`,
 *   `text:`, `memory:`, `run:`, `secret:` and `settings:` scope it to what
 *   is said, written, known, run or kept, which Everywhere searches.
 * - `>` shows only actions, as it does in the editors people already know.
 *
 * Type nothing and it offers what you would most likely want. Type anything
 * else and it searches everything at once, because most of the time you know
 * the name and not the category it lives under: names at once, and under
 * them Everywhere, filling in as the host's full-text search answers.
 */

export interface Action {
  id: string;
  label: string;
  hint?: string;
  /** Grouping label, shown once above a run of results. */
  group: string;
  /** Words that should match this beyond its label. */
  keywords?: string;
  /** Where in the label a search matched. */
  labelMarks?: [number, number][];
  /** The words around a full-text match, under the label. */
  snippet?: Snippet;
  run: () => void;
}

export interface PaletteContext {
  go: (route: Route) => void;
  openChat: (id: string) => void;
  openSettings: () => void;
  newChat: () => void;
  openWorkspace: () => void;
  snapshot: () => void;
  refresh: () => void;
  /** Opens one coding sub-agent's log. */
  openAgent: (id: number) => void;
  /** Where sites are served, when they are. */
  sitesBase: string | null;
  /** Opens a full-text hit where it is: a chat at the message, a file at the line. */
  openTarget: (target: SearchTarget) => void;
  /** The quick question's window. */
  quickAsk?: () => void;
  /** KOS's own browser window. */
  openBrowser?: () => void;
  /** The palette the dashboard is drawn in, chosen here as in Settings. */
  setTheme?: (theme: Theme) => void;
  /** The sheet of the keys there are. */
  showKeys?: () => void;
}

/**
 * Where a page's own create sheet opens: the page, with `?new` on its
 * address, which the page reads once (`useCreateParam`) and takes back off.
 */
export function createHref(route: Route): string {
  return withParams(hrefFor(route), { new: "1" });
}

const KINDS = [
  "project",
  "page",
  "file",
  "schedule",
  "chat",
  "site",
  "agent",
  "build",
  "channel",
  "approval",
  ...SEARCH_KINDS,
  "settings",
] as const;

/** Split `file:budget` into the kind being narrowed to and the term. */
export function parseQuery(raw: string): { kind?: string; term: string; actionsOnly: boolean } {
  const text = raw.trimStart();
  if (text.startsWith(">")) return { term: text.slice(1).trim(), actionsOnly: true };
  const colon = text.indexOf(":");
  if (colon > 0) {
    const kind = text.slice(0, colon).toLowerCase();
    if ((KINDS as readonly string[]).includes(kind)) {
      return { kind, term: text.slice(colon + 1).trim(), actionsOnly: false };
    }
  }
  return { term: text.trim(), actionsOnly: false };
}

/**
 * Subsequence match, the thing that makes "gp" find "Get Projects".
 *
 * Scores a run of consecutive characters higher than the same letters
 * scattered, and a match at a word boundary higher than one mid-word, so
 * "hab" puts "Habit Tracker" above "the-habitual-thing".
 */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  const direct = haystack.indexOf(needle);
  if (direct === 0) return 1000 - text.length;
  if (direct > 0) {
    const boundary = direct === 0 || /[\s/_.-]/.test(haystack[direct - 1] ?? "");
    return (boundary ? 700 : 500) - direct - text.length / 100;
  }

  let score = 0;
  let at = 0;
  let run = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found < 0) return 0;
    const boundary = found === 0 || /[\s/_.-]/.test(haystack[found - 1] ?? "");
    run = found === at ? run + 1 : 0;
    score += 10 + run * 6 + (boundary ? 8 : 0);
    at = found + 1;
  }
  return score - text.length / 100;
}

/**
 * Each group once, in the order its best result earned.
 *
 * The server ranks what it found by relevance across kinds, so a chat, a
 * project and another chat came back in that order and the list showed
 * "Chats" twice. Clustering keeps each group's internal order and puts the
 * group where its first result was.
 */
export function clusterByGroup<T extends { group: string }>(items: T[]): T[] {
  const order: string[] = [];
  const byGroup = new Map<string, T[]>();
  for (const item of items) {
    if (!byGroup.has(item.group)) {
      order.push(item.group);
      byGroup.set(item.group, []);
    }
    byGroup.get(item.group)!.push(item);
  }
  return order.flatMap((g) => byGroup.get(g)!);
}

/** Shorter than this is matched by name only: one letter is in everything. */
export const FULL_TEXT_MIN = 2;
/** How long typing rests before Everywhere asks the host. */
const FULL_TEXT_WAIT_MS = 150;
/** Settings hits shown in Everywhere when not narrowed to them. */
const SETTINGS_SHOWN = 3;

/** Which of the host's sources a query asks: all of them, the one its prefix names, or none. */
export function fullTextKinds(parsed: ReturnType<typeof parseQuery>): SearchKind[] {
  if (parsed.actionsOnly || parsed.term.length < FULL_TEXT_MIN) return [];
  if (parsed.kind === undefined) return [...SEARCH_KINDS];
  return isSearchKind(parsed.kind) ? [parsed.kind] : [];
}

/** Whether names (the @ menu's index) are searched: not when the prefix names a full-text kind. */
export function searchesNames(parsed: ReturnType<typeof parseQuery>): boolean {
  return !parsed.actionsOnly && (parsed.kind === undefined || !(isSearchKind(parsed.kind) || parsed.kind === "settings"));
}

/**
 * Settings, from the index the Settings page searches. Unnarrowed, only a
 * setting whose words hold the query's: the index matches letters in order,
 * which finds "tmzn" on its own page and too much among everything else.
 */
export function settingsHits(parsed: ReturnType<typeof parseQuery>): SearchHit[] {
  if (parsed.actionsOnly || (parsed.kind !== undefined && parsed.kind !== "settings")) return [];
  const narrowed = parsed.kind === "settings";
  const label = (id: string): string => SECTIONS.find((s) => s.id === id)?.label ?? id;
  if (narrowed && !parsed.term) {
    return SECTIONS.map((s, i) => ({ kind: "settings", id: s.id, title: s.label, hint: s.blurb, snippet: { text: "", marks: [] }, score: 1 - i / 100, target: { kind: "settings", section: s.id } }));
  }
  if (parsed.term.length < FULL_TEXT_MIN) return [];
  const words = parsed.term.split(/\s+/).filter(Boolean).length;
  return searchSettings(parsed.term)
    .filter((h) => narrowed || h.score >= 100 * words)
    .slice(0, narrowed ? 12 : SETTINGS_SHOWN)
    .map((h): SearchHit => {
      const title = h.label ?? label(h.section);
      return {
        kind: "settings",
        id: `${h.section}:${h.label ?? ""}`,
        title,
        ...(h.label ? { hint: label(h.section) } : {}),
        snippet: { text: title, marks: marksOfLetters(h.marks) },
        score: h.score >= 100 * words ? 0.95 : 0.4,
        target: { kind: "settings", section: h.section },
      };
    });
}

/** What each kind of hit is called on its row. */
const HIT_WORD: Record<HitKind, string> = {
  msg: "message",
  text: "file",
  memory: "memory",
  run: "run",
  secret: "secret",
  settings: "setting",
};

/**
 * Everywhere's rows, best first across every source. A hit whose words are
 * its name (a secret, a setting) is marked in its label, on one line; the
 * rest show the words around the match under it.
 */
export function everywhereRows(hits: readonly SearchHit[], open: (target: SearchTarget) => void): Action[] {
  return [...hits]
    .sort((a, b) => b.score - a.score)
    .map((h): Action => {
      const named = h.snippet.text === "" || h.snippet.text === h.title;
      const word = h.target.kind === "call" ? "tool call" : HIT_WORD[h.kind];
      return {
        id: `hit:${h.kind}:${h.id}`,
        label: h.title,
        group: "Everywhere",
        hint: [word, h.hint].filter(Boolean).join(" · "),
        ...(named ? (h.snippet.text ? { labelMarks: h.snippet.marks } : {}) : { snippet: h.snippet }),
        run: () => open(h.target),
      };
    });
}

/** Sources still out, said as what they read. */
const SOURCE_WORDS: Record<SearchKind, string> = { msg: "chats", text: "files", memory: "memory", run: "runs", secret: "secrets" };

export function sourcesWords(kinds: readonly SearchKind[]): string {
  const words = kinds.map((k) => SOURCE_WORDS[k]);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What the host said for one query: each source's hits as they came, and those still out or late. */
interface Everywhere {
  term: string;
  hits: Partial<Record<SearchKind, SearchHit[]>>;
  waiting: SearchKind[];
  late: SearchKind[];
}

/** The things you can do, as opposed to the things you can open. */
export function buildActions(ctx: PaletteContext): Action[] {
  const actions: Action[] = [
    {
      id: "kos",
      label: "Open KOS",
      hint: "the thread that routes work across your chats",
      group: "Actions",
      keywords: "orchestrator ask agent",
      run: () => ctx.openChat("orchestrator"),
    },
    {
      id: "new-chat",
      label: "New chat",
      hint: "start a fresh conversation",
      group: "Actions",
      keywords: "compose message talk",
      run: ctx.newChat,
    },
    {
      id: "settings",
      label: "Settings",
      hint: "models, keys, workspace, spend",
      group: "Actions",
      keywords: "preferences config api key provider",
      run: ctx.openSettings,
    },
    {
      id: "open-workspace",
      label: "Open workspace folder",
      hint: "reveal it on this machine",
      group: "Actions",
      keywords: "finder explorer reveal files folder",
      run: ctx.openWorkspace,
    },
    {
      id: "snapshot",
      label: "Snapshot now",
      hint: "commit the workspace as it stands",
      group: "Actions",
      keywords: "backup git commit save",
      run: ctx.snapshot,
    },
    {
      id: "refresh",
      label: "Refresh",
      group: "Actions",
      keywords: "reload update",
      run: ctx.refresh,
    },
    // Each page's own create, so "new project" is typed rather than found.
    ...(
      [
        ["new-project", "New project", "a chat of its own, with its tables and files", "make create", { name: "projects" }],
        ["new-schedule", "New schedule", "something KOS runs on its own, on a timer", "make create cron job timer", { name: "crons" }],
        ["new-claim", "New claim", "something KOS should know, in Memory", "make create memory fact remember", { name: "memory" }],
      ] as const
    ).map(([id, label, hint, keywords, route]): Action => ({ id, label, hint, group: "Actions", keywords, run: () => void (window.location.hash = createHref(route)) })),
  ];
  if (ctx.quickAsk) actions.push({ id: "quick-ask", label: "Quick ask", hint: "a question beside the open chat · ⌘⇧K", group: "Actions", keywords: "btw aside question", run: ctx.quickAsk });
  if (ctx.openBrowser) actions.push({ id: "browser", label: "KOS's browser", hint: "watch it browse · ⌘⇧B", group: "Actions", keywords: "web tab watch window", run: ctx.openBrowser });
  if (ctx.setTheme) {
    const setTheme = ctx.setTheme;
    for (const [theme, label] of [["light", "Light"], ["dark", "Dark"], ["system", "Match the system"]] as const) {
      actions.push({ id: `theme-${theme}`, label: `Theme: ${label}`, group: "Actions", keywords: "appearance colour color mode", run: () => setTheme(theme) });
    }
  }
  if (ctx.showKeys) actions.push({ id: "keys", label: "Keyboard shortcuts", hint: "?", group: "Actions", keywords: "keys help cheat sheet", run: ctx.showKeys });

  // Agents and Schedule sit under Runs in the nav; the palette still names
  // them, since "go to schedule" is what someone will type.
  actions.push(
    {
      id: "go-Blobs",
      label: "Go to Blobs",
      group: "Go to",
      keywords: "agents standing roles responsibilities",
      run: () => ctx.go({ name: "blobs" }),
    },
    {
      id: "go-Builds",
      label: "Go to Builds",
      group: "Go to",
      keywords: "builds coding runs",
      run: () => ctx.go({ name: "builds" }),
    },
    {
      id: "go-Schedule",
      label: "Go to Schedule",
      group: "Go to",
      keywords: "schedule crons jobs runs",
      run: () => ctx.go({ name: "crons" }),
    },
  );

  for (const item of NAV) {
    actions.push({
      id: `go-${item.label}`,
      label: `Go to ${item.label}`,
      group: "Go to",
      keywords: item.label,
      run: () => ctx.go(item.route),
    });
  }

  return actions;
}

const LIST_ID = "pal-results";
const optionId = (index: number): string => `${LIST_ID}-${index}`;
/** How long the list must hold still before its count is said, so a reader hears one number, not each source's. */
const RESULTS_SETTLE_MS = 400;

/** Runs of results that share a group, each row with its place in the whole list. */
function groupRuns(results: readonly Action[]): { group: string; rows: { action: Action; index: number }[] }[] {
  const runs: { group: string; rows: { action: Action; index: number }[] }[] = [];
  results.forEach((action, index) => {
    const last = runs[runs.length - 1];
    if (last && last.group === action.group) last.rows.push({ action, index });
    else runs.push({ group: action.group, rows: [{ action, index }] });
  });
  return runs;
}

/**
 * What each row is called to a screen reader: its name, its hint and the
 * words it matched, and, where two would still read the same (one chat's
 * messages, found seven times), which of them it is.
 */
export function optionNames(results: readonly Action[]): string[] {
  const plain = results.map((r) => [r.label, r.hint, r.snippet?.text].filter(Boolean).join(", "));
  const total = new Map<string, number>();
  for (const name of plain) total.set(name, (total.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return plain.map((name) => {
    const of = total.get(name)!;
    if (of === 1) return name;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return `${name}, ${n} of ${of}`;
  });
}

const KIND_GROUP: Record<string, string> = {
  project: "Projects",
  page: "Pages",
  file: "Files",
  schedule: "Schedule",
  chat: "Chats",
  site: "Sites",
  blob: "Blobs",
  build: "Builds",
  channel: "Channels",
  approval: "Inbox",
};

export function CommandPalette({
  open,
  onClose,
  ctx,
}: {
  open: boolean;
  onClose: () => void;
  ctx: PaletteContext;
}): ReactElement {
  const [query, setQuery] = useState("");
  /** The row under the cursor, by id, so it stays put while Everywhere's rows arrive above or below it. */
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [found, setFound] = useState<
    { kind: string; id: string; label: string; hint?: string; url?: string }[]
  >([]);
  const [everywhere, setEverywhere] = useState<Everywhere | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const actions = useMemo(() => buildActions(ctx), [ctx]);
  const kinds = useMemo(() => fullTextKinds(parsed), [parsed]);
  const settings = useMemo(() => settingsHits(parsed), [parsed]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursorId(null);
    // A frame later: the input does not exist until the sheet has mounted.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  // Search the workspace. Actions are matched locally; everything else lives
  // on the server, which already indexes it for the composer's @ menu.
  useEffect(() => {
    if (!open || !searchesNames(parsed)) {
      setFound([]);
      return;
    }
    let cancelled = false;
    void api
      .mentions(parsed.term, parsed.kind, 20)
      .then((r) => {
        if (!cancelled) setFound(r.mentions);
      })
      .catch(() => {
        if (!cancelled) setFound([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, parsed]);

  // Everywhere: one ask per source, so each group of hits shows as it comes
  // rather than all of them waiting on the slowest (a walk of the files).
  const kindsKey = kinds.join(",");
  useEffect(() => {
    if (!open || kinds.length === 0) {
      setEverywhere(null);
      return;
    }
    const term = parsed.term;
    const stop = new AbortController();
    setEverywhere({ term, hits: {}, waiting: kinds, late: [] });
    const settle = (kind: SearchKind, hits: SearchHit[], late: boolean): void =>
      setEverywhere((e) =>
        e && e.term === term
          ? { ...e, hits: { ...e.hits, [kind]: hits }, waiting: e.waiting.filter((k) => k !== kind), late: late ? [...e.late, kind] : e.late }
          : e,
      );
    const timer = setTimeout(() => {
      for (const kind of kinds) {
        void api
          .search(term, [kind], stop.signal)
          .then((r) => settle(kind, r.hits, r.late.includes(kind)))
          .catch(() => !stop.signal.aborted && settle(kind, [], false));
      }
    }, FULL_TEXT_WAIT_MS);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [open, parsed.term, kindsKey]);

  const results = useMemo((): Action[] => {
    const term = parsed.term;

    // A kind prefix is a statement about what you are looking for, so actions
    // are not mixed in even when their names would match.
    const matchedActions = parsed.kind
      ? []
      : actions
          .map((a) => ({
            a,
            score: Math.max(
              fuzzyScore(a.label, term),
              a.keywords ? fuzzyScore(a.keywords, term) * 0.6 : 0,
            ),
          }))
          .filter((x) => x.score > 0)
          .sort((x, y) => y.score - x.score)
          .map((x) => x.a);

    const opened: Action[] = clusterByGroup(found.map((m) => ({
      id: `${m.kind}:${m.id}`,
      label: m.label,
      group: KIND_GROUP[m.kind] ?? m.kind,
      // A schedule's hint is its line, which is for a tooltip: the words read it back.
      ...(m.hint ? { hint: m.kind === "schedule" ? scheduleWords(m.hint) : m.hint } : {}),
      run: () => {
        if (m.kind === "chat") ctx.openChat(m.id);
        else if (m.kind === "page") ctx.go({ name: "page", id: m.id });
        else if (m.kind === "file") ctx.go({ name: "files", path: m.id });
        else if (m.kind === "schedule") ctx.go({ name: "crons", job: m.id });
        else if (m.kind === "project") ctx.go({ name: "project", slug: m.id });
        else if (m.kind === "blob") ctx.go({ name: "blobs", blob: m.id });
        else if (m.kind === "build") ctx.openAgent(Number(m.id));
        else if (m.kind === "approval") ctx.go({ name: "inbox", id: Number(m.id) });
        // A channel lives on Discord, so it opens there.
        else if (m.kind === "channel" && m.url) window.open(m.url, "_blank", "noreferrer");
        else if (m.kind === "site" && ctx.sitesBase) {
          // Its own origin, so a new tab rather than in place.
          window.open(`${ctx.sitesBase}/${m.id}/`, "_blank", "noreferrer");
        }
      },
    })));

    // Nothing typed: a short list of what you probably want beats a long list
    // of everything the workspace contains.
    if (!term && !parsed.kind) return [...actions.slice(0, 6), ...opened.slice(0, 8)];
    const said = everywhere?.term === term ? Object.values(everywhere.hits).flat() : [];
    return [...matchedActions, ...opened, ...everywhereRows([...said, ...settings], ctx.openTarget)];
  }, [actions, found, everywhere, settings, parsed.kind, parsed.term, ctx]);

  /** Sources still being read for what is typed now. */
  const waiting = everywhere?.term === parsed.term ? everywhere.waiting : [];
  const late = everywhere?.term === parsed.term && everywhere.waiting.length === 0 ? everywhere.late : [];
  const searchedEverywhere = kinds.length > 0 || parsed.kind === "settings";
  const cursor = Math.max(0, results.findIndex((r) => r.id === cursorId));

  useEffect(() => setCursorId(null), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".pal-item.is-cursor")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (action: Action | undefined): void => {
    if (!action) return;
    // Something was chosen: the keys go on with it (the page it opens, a chat's box, a sheet), not back to where the palette was opened from.
    document.querySelector<HTMLElement>("[data-focus-home]")?.focus({ preventScroll: true });
    onClose();
    action.run();
  };

  const names = useMemo(() => optionNames(results), [results]);

  const moveTo = (index: number): void => setCursorId(results[index]?.id ?? null);

  // The tab key stays in the palette and, shut by Escape, the focus goes back to what had it.
  useFocusTrap(box, open);

  // What the list holds, said once it settles: a reader hears the count, or that nothing matches.
  const typed = Boolean(parsed.term || parsed.kind);
  const heard = !open || !typed ? null : results.length > 0 ? `${results.length} ${results.length === 1 ? "result" : "results"}` : waiting.length > 0 ? null : "Nothing matches.";
  useEffect(() => {
    if (!heard) return;
    const timer = setTimeout(() => announce(heard), RESULTS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [heard]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length) moveTo((cursor + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) moveTo((cursor - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  /** Everywhere's last line: what is still being read, or what did not answer in time, or that nothing else holds it. */
  const shownEverywhere = results.some((r) => r.group === "Everywhere");
  const everywhereNote = waiting.length > 0
    ? shownEverywhere ? null : `Searching ${sourcesWords(waiting)}…`
    : late.length > 0
      ? `${sourcesWords(late).replace(/^./, (c) => c.toUpperCase())} did not answer in time; try again or narrow with ${late.map((k) => `${k}:`).join(" ")}`
      : searchedEverywhere && !shownEverywhere
        ? "No message, file, memory, run or secret holds it."
        : null;

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={ease}
            onClick={onClose}
          />
          <div className="pal-wrap">
            <m.div
              ref={box}
              className="pal"
              role="dialog"
              aria-modal="true"
              aria-label="Search and commands"
              // At its final place and size from the first frame, fading in: its list fills under the box, and a box that grew while it scaled read as two motions.
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={ease}
            >
              <input
                ref={inputRef}
                className="pal-input"
                value={query}
                placeholder="Search everything, or > for commands"
                aria-label="Search everything, or > for commands"
                role="combobox"
                aria-expanded={results.length > 0}
                aria-controls={LIST_ID}
                aria-autocomplete="list"
                {...(results.length > 0 ? { "aria-activedescendant": optionId(cursor) } : {})}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {/* A phone has no Escape: its way out is a word, shown only there (touch.css). */}
              <button type="button" className="btn btn--ghost pal-cancel" onClick={onClose}>
                Cancel
              </button>

              {results.length === 0 ? (
                <EmptyState variant="inline" className="pal-empty">
                  {waiting.length > 0
                    ? `Searching ${sourcesWords(waiting)}…`
                    : parsed.term || parsed.kind
                      ? "Nothing matches."
                      : "Start typing."}
                </EmptyState>
              ) : (
                <ul className="pal-list" ref={listRef} id={LIST_ID} role="listbox" aria-label="Results">
                  {groupRuns(results).map(({ group, rows }) => (
                    <li key={`${group}:${rows[0]!.index}`} role="group" aria-labelledby={`${LIST_ID}-g${rows[0]!.index}`}>
                      <div className="label pal-group" id={`${LIST_ID}-g${rows[0]!.index}`}>
                        {group}
                        {group === "Everywhere" && waiting.length > 0 && <span className="pal-group-note">searching {sourcesWords(waiting)}…</span>}
                      </div>
                      <ul className="pal-rows" role="none">
                        {rows.map(({ action: r, index: i }) => (
                          <li
                            key={r.id}
                            id={optionId(i)}
                            role="option"
                            aria-selected={i === cursor}
                            aria-label={names[i]}
                            className={`pal-item${r.snippet ? " pal-item--hit" : ""}${i === cursor ? " is-cursor" : ""}`}
                            onMouseMove={() => setCursorId(r.id)}
                            onClick={() => choose(r)}
                          >
                            <span className="pal-line">
                              <span className="pal-label">{r.labelMarks ? <Marked text={r.label} marks={r.labelMarks} /> : r.label}</span>
                              {r.hint && <span className="pal-hint">{r.hint}</span>}
                            </span>
                            {r.snippet && (
                              <span className="pal-snippet">
                                <Marked text={r.snippet.text} marks={r.snippet.marks} />
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                  {everywhereNote && (
                    <li role="none">
                      {!shownEverywhere && <div className="label pal-group">Everywhere</div>}
                      <p className="pal-note">{everywhereNote}</p>
                    </li>
                  )}
                </ul>
              )}

              <footer className="pal-foot">
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> move
                </span>
                <span>
                  <kbd>↵</kbd> open
                </span>
                <span>
                  <kbd>&gt;</kbd> commands
                </span>
                <span>
                  <kbd>file:</kbd> <kbd>msg:</kbd> narrow
                </span>
              </footer>
            </m.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
