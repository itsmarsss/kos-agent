import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";

import { CloseIcon, Count, Empty, IconButton, NavIcon, PinIcon, RefChip, SearchIcon, Tag, useDismiss, useFocusTrap, useOverlayScroll } from "@kos/kit";
import { timeCard } from "@kos/shared";

import type { TurnRecall as Recall } from "./api.js";
import { useEdgeFade } from "./edgefade.js";
import { canonicalScope, describeScope } from "./KnowledgePage.js";
import { hrefFor } from "./routes.js";
import { agoWords } from "./schedulewords.js";

/**
 * What the last turn was given from memory.
 *
 * Memory is sent to the model and then stripped from the transcript, so until
 * now the only way to see what KOS remembered for a turn was to read the
 * prompt. A chip says how much came along; opening it says what, grouped by
 * why it came (pinned, the project in play, everywhere, the log), so a wrong
 * or stale claim can be found from the conversation it misled.
 */

type Fact = Recall["facts"][number];
type Moment = Recall["events"][number];

export type RecallItem = { kind: "claim"; id: string; fact: Fact; title: string; body: string } | { kind: "moment"; id: string; moment: Moment };

export interface RecallGroup {
  id: string;
  label: string;
  /** Why what is in it came along, when the group's name does not say. */
  hint?: string;
  /** Its rows say their scope, which the group's name does not. */
  scoped: boolean;
  items: RecallItem[];
}

/** Items from which the panel offers a filter. */
export const FILTER_FROM = 7;

/** Words of a key that name nothing on their own. */
const GENERIC = new Set(["fact", "facts", "claim", "note", "notes", "pref", "prefs", "preference", "memory", "misc", "item", "entry", "info", "data", "value"]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A text's first sentence, and what follows it. */
function splitSentence(text: string): [string, string] {
  const m = /^([\s\S]+?[.!?])\s+(\S[\s\S]*)$/.exec(text.trim());
  return m?.[1] && m[2] ? [m[1], m[2]] : [text.trim(), ""];
}

/**
 * A word of a key as the claim itself writes it: "calhacks" is "CalHacks" and
 * "mef" is "MEF" when the claim writes them so mid-sentence, where a capital
 * means a name rather than a sentence's start.
 */
function casedLike(word: string, text: string): string | null {
  for (const m of text.matchAll(new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(word)})(?![\\p{L}\\p{N}])`, "giu"))) {
    const found = m[2]!;
    if (found === found.toLowerCase()) continue;
    const before = text.slice(0, (m.index ?? 0) + m[1]!.length).trimEnd();
    if (before !== "" && !/[.!?:]$/.test(before)) return found;
  }
  return null;
}

/**
 * A claim's title and body: its key in words ("mef_calhacks_purchase" reads
 * "MEF CalHacks purchase") over the claim, or the claim's first sentence
 * over the rest when the key names nothing (an id, "note_3", a link).
 */
export function claimTitle(key: string, value: string): { title: string; body: string } {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(key)) {
    const [title, body] = splitSentence(value);
    return { title, body };
  }
  const words = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[\s_.:/-]+/)
    .filter(Boolean);
  const naming = words.filter((w) => /\p{L}{3}/u.test(w) && !/\d/.test(w) && !GENERIC.has(w.toLowerCase()));
  if (naming.length === 0) {
    const [title, body] = splitSentence(value);
    return { title, body };
  }
  const title = words
    .map((w, i) => {
      const cased = casedLike(w, value);
      if (cased) return cased;
      // A course or a model code ("cs341", "m3") is written in capitals.
      if (/^\p{L}{1,4}\d+$/u.test(w)) return w.toUpperCase();
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
  return { title, body: value };
}

/**
 * The turn's memory in the order it is read: what is always there, then the
 * project in play, then everywhere, then any other scope, then the moments
 * from the log. A group with nothing in it is left out.
 */
export function groupRecall(recalled: Recall): RecallGroup[] {
  const project = recalled.projectSlug ? canonicalScope(`project:${recalled.projectSlug}`) : null;
  const claim = (f: Fact): RecallItem => ({ kind: "claim", id: `c${f.id}`, fact: f, ...claimTitle(f.key, f.value) });
  const byScope = new Map<string, Fact[]>();
  for (const f of recalled.facts.filter((f) => !f.pinned)) {
    const scope = canonicalScope(f.scope);
    byScope.set(scope, [...(byScope.get(scope) ?? []), f]);
  }
  const groups: RecallGroup[] = [
    { id: "pinned", label: "Pinned", hint: "in every turn", scoped: true, items: recalled.facts.filter((f) => f.pinned).map(claim) },
    { id: "project", label: "This project", scoped: false, items: (project ? (byScope.get(project) ?? []) : []).map(claim) },
    { id: "global", label: "Everywhere", scoped: false, items: (byScope.get("global") ?? []).map(claim) },
    ...[...byScope.entries()]
      .filter(([scope]) => scope !== project && scope !== "global")
      .map(([scope, facts]): RecallGroup => {
        const words = describeScope(scope);
        return { id: scope, label: words.charAt(0).toUpperCase() + words.slice(1), scoped: false, items: facts.map(claim) };
      }),
    { id: "moments", label: "Log", hint: "what was said, close to the last message", scoped: false, items: recalled.events.map((e) => ({ kind: "moment", id: `m${e.id}`, moment: e })) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Whether an item has every word of a filter, in its title, words, key or scope. */
export function itemMatches(item: RecallItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (item.kind === "claim" ? [item.title, item.fact.value, item.fact.key, describeScope(item.fact.scope)] : [item.moment.text, roleWord(item.moment.role)]).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Who a claim is from, as a tag, and what that means. */
const SOURCES: Record<string, [string, string]> = {
  owner: ["from you", "You said this"],
  agent: ["from KOS", "KOS worked this out"],
  tool: ["from a tool", "A tool produced this"],
  external: ["from outside", "From outside KOS: read it with care"],
};

function roleWord(role: string): string {
  return role === "owner" ? "You" : role === "agent" ? "KOS" : role.charAt(0).toUpperCase() + role.slice(1);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Memory's mark, before the counts: what the chip is about, without a "memory:" label. */
function MemoryGlyph(): ReactElement {
  return (
    <span className="recall-glyph" aria-hidden="true">
      <NavIcon name="memory" />
    </span>
  );
}

/** The Memory page showing these claims alone, or its log when there are only moments. */
function memoryHref(recalled: Recall): string {
  const base = hrefFor({ name: "memory" });
  return recalled.facts.length === 0 ? `${base}?tab=log` : `${base}?tab=claims&ids=${recalled.facts.map((f) => f.id).join(",")}`;
}

export function TurnRecall({ recalled }: { recalled: Recall }): ReactElement | null {
  // Open for the recall it was opened on: the next turn's, or none, shuts it.
  const [openAt, setOpenAt] = useState<number | null>(null);
  const open = openAt === recalled.at;
  const wrap = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const leave = (): void => setOpenAt(null);
  const close = (): void => {
    leave();
    chip.current?.focus();
  };
  useDismiss(open, close, { inside: [wrap, pop] });

  const facts = recalled.facts.length;
  const moments = recalled.events.length;
  if (facts === 0 && moments === 0) {
    return (
      <span className="recall recall--none" title="Nothing in memory matched the last message.">
        <MemoryGlyph />
        <span className="sr-only">Memory: </span>
        nothing matched
      </span>
    );
  }
  const counts = [facts > 0 ? plural(facts, "claim") : null, moments > 0 ? plural(moments, "log entry", "log entries") : null].filter(Boolean).join(" · ");

  return (
    <div className="recall" ref={wrap}>
      <button
        ref={chip}
        type="button"
        className={`recall-chip${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpenAt(recalled.at))}
        title="What the last turn was given from memory"
        aria-label={`Memory: ${counts}`}
      >
        <MemoryGlyph />
        {counts}
      </button>
      {open && createPortal(<RecallPanel recalled={recalled} counts={counts} anchor={chip} wrap={wrap} pop={pop} onClose={close} onLeave={leave} />, document.body)}
    </div>
  );
}

/** The gap between the panel and what it sits over, and its least margin from the window's edge. */
const GAP = 8;

/**
 * Where the panel sits: over the composer the chip is in (the chip itself
 * outside one), never on it, and inside the window. With little room above,
 * it is shorter rather than over what the owner is typing. On a phone it is
 * a sheet from the foot instead (styles.css).
 */
function usePlacement(anchor: RefObject<HTMLElement | null>): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    const chip = anchor.current;
    if (!chip) return;
    const box = chip.getBoundingClientRect();
    const above = (chip.closest(".composer-box") ?? chip).getBoundingClientRect().top;
    const width = Math.min(560, window.innerWidth - 2 * GAP);
    setStyle({
      "--recall-w": `${width}px`,
      "--recall-x": `${Math.max(GAP, Math.min(box.left, window.innerWidth - width - GAP))}px`,
      "--recall-y": `${window.innerHeight - above + GAP}px`,
      "--recall-h": `${Math.max(0, Math.min(560, above - 2 * GAP))}px`,
    } as CSSProperties);
  }, [anchor]);
  return style;
}

/** Whether the window answers a media query, false where it cannot be asked. */
const media = (query: string): boolean => typeof window.matchMedia === "function" && window.matchMedia(query).matches;

function RecallPanel({
  recalled,
  counts,
  anchor,
  wrap,
  pop,
  onClose,
  onLeave,
}: {
  recalled: Recall;
  counts: string;
  anchor: RefObject<HTMLElement | null>;
  /** The chip's own box: the focus going there is not leaving. */
  wrap: RefObject<HTMLElement | null>;
  pop: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /** Closes without taking the focus back: it has gone somewhere else. */
  onLeave: () => void;
}): ReactElement {
  const titleId = useId();
  // A phone's sheet (styles.css) holds the focus as a dialog does; a touch screen's filter would raise its keyboard.
  const [sheet] = useState(() => media("(max-width: 640px)"));
  const [touch] = useState(() => sheet || media("(pointer: coarse)"));
  useFocusTrap(pop, sheet);
  const style = usePlacement(anchor);
  const fade = useEdgeFade<HTMLDivElement>(undefined, "y");
  const scroller = useOverlayScroll(fade);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const groups = useMemo(() => groupRecall(recalled), [recalled]);
  const total = recalled.facts.length + recalled.events.length;
  const shown = useMemo(() => groups.map((g) => ({ ...g, items: g.items.filter((i) => itemMatches(i, query)) })).filter((g) => g.items.length > 0), [groups, query]);

  // The focus goes in with the panel so the keys work at once: to the filter, or on a touch screen to the first row.
  useLayoutEffect(() => {
    const first = pop.current?.querySelector<HTMLElement>(touch ? ".recall-toggle" : ".recall-find input, .recall-toggle");
    (first ?? pop.current)?.focus({ preventScroll: true });
  }, [pop, touch]);

  /** Tabbing out of the panel on a desktop is leaving it, as pressing away is. */
  const blurred = (e: FocusEvent<HTMLDivElement>): void => {
    const to = e.relatedTarget;
    if (sheet || !(to instanceof Node) || pop.current?.contains(to) || wrap.current?.contains(to)) return;
    onLeave();
  };

  const toggle = (id: string): void =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** Up and down move between the filter and the rows; Home and End, from a row, go to the first and the last. */
  const rove = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>(".recall-find input, .recall-toggle")];
    const rows = stops.filter((s) => s.classList.contains("recall-toggle"));
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const inRow = rows.includes(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? (inRow ? rows[0] : undefined)
      : e.key === "End" ? (inRow ? rows.at(-1) : undefined)
      : stops[Math.max(0, Math.min(stops.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next || next === document.activeElement) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <>
      <div className="recall-scrim" aria-hidden="true" />
      <div className="kos-pop recall-pop" ref={pop} style={style} role="dialog" aria-modal={sheet || undefined} aria-labelledby={titleId} tabIndex={-1} onKeyDown={rove} onBlur={blurred}>
        <header className="recall-head">
          <div className="recall-head-top">
            <h2 className="recall-title" id={titleId}>
              What KOS remembered for this turn
            </h2>
            <IconButton tone="bare" label="Close" onClick={onClose}>
              <CloseIcon size={12} title="" />
            </IconButton>
          </div>
          <div className="recall-sub">
            <span className="recall-counts">{counts}</span>
            {recalled.projectSlug && (
              <RefChip kind="project" href={hrefFor({ name: "project", slug: recalled.projectSlug })} title="The project in play for this turn">
                {recalled.projectSlug}
              </RefChip>
            )}
            <a className="recall-open" href={memoryHref(recalled)} onClick={onClose}>
              Open in Memory
            </a>
          </div>
          {total >= FILTER_FROM && (
            <label className="know-search recall-find">
              <SearchIcon size={14} title="" />
              <input type="search" value={query} placeholder="Filter what was remembered…" aria-label="Filter what was remembered" onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
        </header>
        <div className="recall-body" ref={scroller}>
          <div className="recall-groups">
            {shown.length === 0 && (
              <Empty inline className="recall-none">
                Nothing here matches “{query.trim()}”.{" "}
                <button type="button" className="link" onClick={() => setQuery("")}>
                  Clear the filter
                </button>
              </Empty>
            )}
            {shown.map((g) => (
              <section key={g.id} className="recall-group" aria-label={g.label}>
                <h3 className="label recall-group-head">
                  {g.label} <Count n={g.items.length} />
                  {g.hint && <span className="recall-group-hint">{g.hint}</span>}
                </h3>
                <ul className="recall-list">
                  {g.items.map((item) => (
                    <RecallRow key={item.id} item={item} scoped={g.scoped} open={expanded.has(item.id)} onToggle={() => toggle(item.id)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One claim or moment: a line of title and tags over its words, two lines of
 * them until it is opened. The title line opens it, so the words can be
 * selected and copied.
 */
function RecallRow({ item, scoped, open, onToggle }: { item: RecallItem; scoped: boolean; open: boolean; onToggle: () => void }): ReactElement {
  const pinned = item.kind === "claim" && item.fact.pinned;
  const text = item.kind === "claim" ? item.body : item.moment.text;
  return (
    <li className={`recall-row${pinned ? " is-pinned" : ""}${open ? " is-open" : ""}`}>
      <div className="recall-item">
        <button type="button" className="recall-toggle" aria-expanded={open} onClick={onToggle}>
          {item.kind === "claim" ? <ClaimHead item={item} scoped={scoped} /> : <MomentHead moment={item.moment} />}
        </button>
        {text && <p className="recall-item-text">{text}</p>}
        {open && item.kind === "claim" && <code className="recall-key">{item.fact.key}</code>}
      </div>
    </li>
  );
}

function ClaimHead({ item, scoped }: { item: Extract<RecallItem, { kind: "claim" }>; scoped: boolean }): ReactElement {
  const { fact } = item;
  const [source, sourceTitle] = SOURCES[fact.trust] ?? [fact.trust, `Trust: ${fact.trust}`];
  return (
    <>
      {fact.pinned && (
        <span className="recall-pin">
          <PinIcon size={12} title="Pinned: in every turn" />
        </span>
      )}
      <span className="recall-item-title">{item.title}</span>
      <span className="recall-tags">
        {scoped && <Tag title="Where this claim applies">{describeScope(fact.scope)}</Tag>}
        <Tag title={sourceTitle}>{source}</Tag>
      </span>
    </>
  );
}

function MomentHead({ moment }: { moment: Moment }): ReactElement {
  const when = new Date(moment.ts);
  return (
    <>
      <span className="recall-item-title">{roleWord(moment.role)} said</span>
      {/* A moment whose time was lost says nothing of when rather than "Invalid Date". */}
      {Number.isFinite(when.getTime()) && (
        <span className="recall-tags">
          <time className="recall-when" dateTime={when.toISOString()} title={timeCard(moment.ts / 1000).join(" ")}>
            {agoWords(moment.ts)}
          </time>
        </span>
      )}
    </>
  );
}
