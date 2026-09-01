import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { api } from "./api.js";
import { ease } from "./motion.js";

/**
 * @ to point at something in the workspace, / to run a command.
 *
 * The trigger is read from the text before the caret rather than from the
 * keystroke, so it survives pasting, editing mid-sentence, and deleting back
 * into a half-typed mention.
 */

export interface Suggestion {
  /** What replaces the trigger and its query. */
  insert: string;
  label: string;
  hint?: string;
  kind: string;
  /**
   * Leaves the caret inside the reference instead of finishing it. Picking a
   * kind is half a reference: the next thing typed narrows within it.
   */
  partial?: boolean;
}

export interface Trigger {
  /** "@" or "/". */
  char: string;
  /** What has been typed after it. */
  query: string;
  /** Index of the trigger character in the text. */
  at: number;
}

/**
 * The mention or command being typed at the caret, if any.
 *
 * A trigger only counts at the start of a word: an email address is not a
 * mention, and a path is not a command.
 */
export const MENTION_KINDS = [
  "project",
  "page",
  "file",
  "schedule",
  "chat",
  "site",
  "agent",
] as const;

/** Split `file:notes/a` into the kind being narrowed to and the term. */
export function splitQuery(query: string): { kind?: string; term: string } {
  const colon = query.indexOf(":");
  if (colon < 0) return { term: query };
  const kind = query.slice(0, colon);
  if (!(MENTION_KINDS as readonly string[]).includes(kind)) return { term: query };
  return { kind, term: query.slice(colon + 1) };
}

export function readTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  // The query keeps colons and slashes, so a half-typed reference is still a
  // trigger: backspacing into @file:notes/a leaves a live search rather than
  // a dead string, and typing a kind narrows to it.
  const match = /(^|\s)([@/])([^\s@]*)$/.exec(before);
  if (!match) return null;
  const char = match[2] as string;
  const query = match[3] ?? "";
  // A slash command is only ever the first thing in the message.
  if (char === "/" && before.trimStart().length !== query.length + 1) return null;
  return { char, query, at: caret - query.length - 1 };
}

export function applySuggestion(
  text: string,
  trigger: Trigger,
  suggestion: Suggestion,
): { text: string; caret: number } {
  const head = text.slice(0, trigger.at);
  const tail = text.slice(trigger.at + 1 + trigger.query.length);
  const inserted = suggestion.partial ? suggestion.insert : `${suggestion.insert} `;
  return { text: head + inserted + tail, caret: head.length + inserted.length };
}

const KIND_LABEL: Record<string, string> = {
  project: "project",
  page: "page",
  file: "file",
  schedule: "schedule",
  chat: "chat",
  site: "site",
  agent: "agent",
  command: "command",
};

export function useSuggestions(trigger: Trigger | null): Suggestion[] {
  const [mentions, setMentions] = useState<Suggestion[]>([]);
  const [commands, setCommands] = useState<Suggestion[]>([]);
  const query = trigger?.query ?? "";
  const char = trigger?.char ?? "";

  const split = splitQuery(query);

  useEffect(() => {
    if (char !== "@") return;
    let cancelled = false;
    void api
      .mentions(split.term, split.kind)
      .then((r) => {
        if (cancelled) return;
        setMentions(
          r.mentions.map((mn) => ({
            insert: `@${mn.kind}:${mn.id}`,
            label: mn.label,
            kind: mn.kind,
            ...(mn.hint ? { hint: mn.hint } : {}),
          })),
        );
        setCommands(
          r.commands.map((c) => ({
            insert: `/${c.name}`,
            label: `/${c.name}${c.args ? ` ${c.args}` : ""}`,
            kind: "command",
            hint: c.description,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setMentions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [char, split.kind, split.term]);

  // Commands come back with the mentions, so the list is there before the
  // first slash is typed and the menu does not flash empty.
  useEffect(() => {
    if (commands.length > 0) return;
    void api
      .mentions("")
      .then((r) =>
        setCommands(
          r.commands.map((c) => ({
            insert: `/${c.name}`,
            label: `/${c.name}${c.args ? ` ${c.args}` : ""}`,
            kind: "command",
            hint: c.description,
          })),
        ),
      )
      .catch(() => undefined);
  }, [commands.length]);

  return useMemo(() => {
    if (!trigger) return [];
    if (trigger.char === "/") {
      const q = trigger.query.toLowerCase();
      return commands.filter((c) => c.label.toLowerCase().includes(q));
    }
    // Before a kind is chosen, offer the kinds themselves: typing @fi should
    // get you to files rather than only matching things called "fi".
    const kinds: Suggestion[] =
      split.kind === undefined
        ? MENTION_KINDS.filter((k) => k.startsWith(split.term.toLowerCase())).map(
            (k) => ({
              insert: `@${k}:`,
              label: `${k}:`,
              kind: k,
              hint: `only ${k}s`,
              partial: true,
            }),
          )
        : [];
    return [...kinds, ...mentions];
  }, [trigger, mentions, commands, split.kind, split.term]);
}

export function AutocompleteMenu({
  suggestions,
  cursor,
  onPick,
}: {
  suggestions: Suggestion[];
  cursor: number;
  onPick: (s: Suggestion) => void;
}): ReactElement | null {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".ac-item.is-cursor")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <AnimatePresence>
      {suggestions.length > 0 && (
        <m.ul
          className="ac"
          ref={listRef}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={ease}
        >
          {suggestions.map((s, i) => (
            <li key={s.insert}>
              <button
                type="button"
                className={`ac-item ${i === cursor ? "is-cursor" : ""}`}
                // Mouse down rather than click: the textarea must not lose the
                // caret before the insertion is worked out.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(s);
                }}
              >
                <span className="ac-kind">{KIND_LABEL[s.kind] ?? s.kind}</span>
                <span className="ac-label">{s.label}</span>
                {s.hint && <span className="ac-hint">{s.hint}</span>}
              </button>
            </li>
          ))}
        </m.ul>
      )}
    </AnimatePresence>
  );
}
