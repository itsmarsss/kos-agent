import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { api } from "./api.js";
import { ease } from "./motion.js";
import { NAV, type Route } from "./routes.js";

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
 *   to one kind, the same prefixes the composer's @ menu uses.
 * - `>` shows only actions, as it does in the editors people already know.
 *
 * Type nothing and it offers what you would most likely want. Type anything
 * else and it searches everything at once, because most of the time you know
 * the name and not the category it lives under.
 */

export interface Action {
  id: string;
  label: string;
  hint?: string;
  /** Grouping label, shown once above a run of results. */
  group: string;
  /** Words that should match this beyond its label. */
  keywords?: string;
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
}

const KINDS = [
  "project",
  "page",
  "file",
  "schedule",
  "chat",
  "site",
  "agent",
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
  ];

  // Home is not in the nav any more, it is behind the wordmark. It is still a
  // place you can go, so the palette still offers it: a page reachable by
  // exactly one unlabelled click is a page people do not find.
  actions.push({
    id: "go-Home",
    label: "Go to Home",
    group: "Go to",
    keywords: "dashboard start overview panels",
    run: () => ctx.go({ name: "home" }),
  });

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

const KIND_GROUP: Record<string, string> = {
  project: "Projects",
  page: "Pages",
  file: "Files",
  schedule: "Schedule",
  chat: "Chats",
  site: "Sites",
  agent: "Agents",
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
  const [cursor, setCursor] = useState(0);
  const [found, setFound] = useState<
    { kind: string; id: string; label: string; hint?: string }[]
  >([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const actions = useMemo(() => buildActions(ctx), [ctx]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    // A frame later: the input does not exist until the sheet has mounted.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  // Search the workspace. Actions are matched locally; everything else lives
  // on the server, which already indexes it for the composer's @ menu.
  useEffect(() => {
    if (!open || parsed.actionsOnly) {
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
  }, [open, parsed.term, parsed.kind, parsed.actionsOnly]);

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

    const opened: Action[] = found.map((m) => ({
      id: `${m.kind}:${m.id}`,
      label: m.label,
      group: KIND_GROUP[m.kind] ?? m.kind,
      ...(m.hint ? { hint: m.hint } : {}),
      run: () => {
        if (m.kind === "chat") ctx.openChat(m.id);
        else if (m.kind === "page") ctx.go({ name: "page", id: m.id });
        else if (m.kind === "file") ctx.go({ name: "files", path: m.id });
        else if (m.kind === "schedule") ctx.go({ name: "crons" });
        else if (m.kind === "project") ctx.go({ name: "projects" });
        else if (m.kind === "agent") ctx.openAgent(Number(m.id));
        else if (m.kind === "site" && ctx.sitesBase) {
          // Its own origin, so a new tab rather than in place.
          window.open(`${ctx.sitesBase}/${m.id}/`, "_blank", "noreferrer");
        }
      },
    }));

    // Nothing typed: a short list of what you probably want beats a long list
    // of everything the workspace contains.
    if (!term && !parsed.kind) return [...actions.slice(0, 6), ...opened.slice(0, 8)];
    return [...matchedActions, ...opened];
  }, [actions, found, parsed.kind, parsed.term, ctx]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".pal-item.is-cursor")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (action: Action | undefined): void => {
    if (!action) return;
    onClose();
    action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

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
              className="pal"
              role="dialog"
              aria-label="Search and commands"
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={ease}
            >
              <input
                ref={inputRef}
                className="pal-input"
                value={query}
                placeholder="Search everything, or > for commands"
                aria-label="Search everything, or > for commands"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />

              {results.length === 0 ? (
                <p className="pal-empty">
                  {parsed.term || parsed.kind
                    ? "Nothing matches."
                    : "Start typing."}
                </p>
              ) : (
                <ul className="pal-list" ref={listRef}>
                  {results.map((r, i) => {
                    const first = i === 0 || results[i - 1]?.group !== r.group;
                    return (
                      <li key={r.id}>
                        {first && <div className="pal-group">{r.group}</div>}
                        <button
                          type="button"
                          className={`pal-item ${i === cursor ? "is-cursor" : ""}`}
                          onMouseMove={() => setCursor(i)}
                          onClick={() => choose(r)}
                        >
                          <span className="pal-label">{r.label}</span>
                          {r.hint && <span className="pal-hint">{r.hint}</span>}
                        </button>
                      </li>
                    );
                  })}
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
                  <kbd>file:</kbd> narrow
                </span>
              </footer>
            </m.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
