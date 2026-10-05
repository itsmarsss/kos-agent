import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { api } from "./api.js";
import { ease } from "./motion.js";

/**
 * @ to point at something in the workspace, / to run a command, and after a
 * command that takes a thing (a chat, an agent, a waiting approval), that
 * thing.
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
  /** "@" for a mention, "/" for a command, "arg" for what a command takes. */
  char: "@" | "/" | "arg";
  /** What has been typed after it. */
  query: string;
  /**
   * Index of the trigger character in the text; for an argument, of the
   * argument's first character, since nothing introduces it but a space.
   */
  at: number;
  /** For an argument: the command it belongs to, by its canonical name. */
  command?: ArgCommand;
}

/** The commands whose argument is a thing that can be offered. */
export type ArgCommand = "switch" | "dispatch" | "approve" | "deny";

const ARG_COMMANDS: Record<string, ArgCommand> = {
  switch: "switch",
  s: "switch",
  go: "switch",
  goto: "switch",
  dispatch: "dispatch",
  delegate: "dispatch",
  approve: "approve",
  yes: "approve",
  deny: "deny",
  no: "deny",
  reject: "deny",
};

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
  if (match) {
    const char = match[2] as "@" | "/";
    const query = match[3] ?? "";
    // A slash command is only ever the first thing in the message.
    if (char === "/" && before.trimStart().length !== query.length + 1) return null;
    return { char, query, at: caret - query.length - 1 };
  }
  // After a command and a space: its argument, for the commands that take a
  // nameable thing. A dispatch names the agent before the colon; past it is
  // the task, which is prose.
  const arg = /^\s*\/(\S+)\s+([^\n]*)$/.exec(before);
  if (!arg) return null;
  const command = ARG_COMMANDS[(arg[1] ?? "").toLowerCase()];
  if (!command) return null;
  const query = arg[2] ?? "";
  if (command === "dispatch" && query.includes(":")) return null;
  return { char: "arg", query, at: caret - query.length, command };
}

export function applySuggestion(
  text: string,
  trigger: Trigger,
  suggestion: Suggestion,
): { text: string; caret: number } {
  // An argument has no trigger character of its own to replace.
  const lead = trigger.char === "arg" ? 0 : 1;
  const head = text.slice(0, trigger.at);
  const tail = text.slice(trigger.at + lead + trigger.query.length);
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
  approval: "waiting",
};

export interface SuggestionOptions {
  /** The project the chat is in, whose own things are offered first. */
  project?: string;
  /** What is waiting on the owner, for `/approve` and `/deny`. */
  approvals?: { id: number; label: string; here: boolean }[];
}

export function useSuggestions(trigger: Trigger | null, options: SuggestionOptions = {}): Suggestion[] {
  const [mentions, setMentions] = useState<Suggestion[]>([]);
  const [commands, setCommands] = useState<Suggestion[]>([]);
  const query = trigger?.query ?? "";
  const char = trigger?.char ?? "";
  const command = trigger?.command;
  const { project, approvals } = options;

  const split = splitQuery(query);
  // A chat is what /switch and /dispatch take; the index is asked for chats
  // only, with the project's own first.
  const wantsChats = char === "arg" && (command === "switch" || command === "dispatch");

  // What is being looked for, apart from the term. When it changes, the last
  // answer is for something else and is dropped rather than shown until the
  // next one lands: chats under "@file:", for a moment, was that.
  const mode = `${char}:${wantsChats ? "chat" : (split.kind ?? "")}`;
  useEffect(() => setMentions([]), [mode]);

  useEffect(() => {
    if (char !== "@" && !wantsChats) return;
    let cancelled = false;
    void api
      .mentions(wantsChats ? query : split.term, wantsChats ? "chat" : split.kind, undefined, project)
      .then((r) => {
        if (cancelled) return;
        setMentions(
          r.mentions.map((mn) => ({
            // Bracketed when the id has anything the plain form cannot
            // carry. A schedule is named by the owner and usually has spaces
            // in it, so this inserted a reference that read as far as the
            // first space and pointed at nothing.
            insert: /^[A-Za-z0-9._/-]*[A-Za-z0-9_/-]$/.test(mn.id)
              ? `@${mn.kind}:${mn.id}`
              : `@${mn.kind}:[${mn.id}]`,
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
  }, [char, wantsChats, query, split.kind, split.term, project]);

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
    if (trigger.char === "arg") {
      if (trigger.command === "approve" || trigger.command === "deny") {
        // What is waiting, this chat's first; picked by number.
        const q = trigger.query.replace(/^#/, "").toLowerCase();
        return (approvals ?? [])
          .filter((a) => !q || String(a.id).startsWith(q) || a.label.toLowerCase().includes(q))
          .sort((a, b) => Number(b.here) - Number(a.here) || a.id - b.id)
          .map((a) => ({
            insert: `#${a.id}`,
            label: `#${a.id} ${a.label}`,
            kind: "approval",
            hint: a.here ? "this chat" : "another chat",
          }));
      }
      // A chat by its title, which is how the command resolves it. For a
      // dispatch the colon comes with it, and the task is typed after.
      return mentions.map((mn) =>
        trigger.command === "dispatch"
          ? { insert: `${mn.label}: `, label: mn.label, kind: mn.kind, partial: true, ...(mn.hint ? { hint: mn.hint } : {}) }
          : { insert: mn.label, label: mn.label, kind: mn.kind, ...(mn.hint ? { hint: mn.hint } : {}) },
      );
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
  }, [trigger, mentions, commands, approvals, split.kind, split.term]);
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
