import { kindWord, slugWords, timeWords } from "@kos/shared";
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from "react";

import { Chips, CloseIcon, Count, EditIcon, EmptyState, Field, GroupHead, IconButton, PinIcon, SheetFoot, Tag, UnpinIcon } from "@kos/kit";

import { api, type FactRow } from "./api.js";
import { Drawer } from "./Drawer.js";
import { Modal } from "./Modal.js";
import { useEdgeFade } from "./edgefade.js";
import { useHashParam } from "./hashparams.js";
import { hrefFor } from "./routes.js";
import { ConfirmButton } from "./kit.js";

import { Select } from "./Select.js";

/**
 * Claims: what KOS and every conversation know.
 *
 * It is the one place state outlives a conversation. It was a card per
 * claim, three lines of each, under a wall of fifty tag chips, so the page
 * ran to screens and read as noise. Now it is a list per scope (everywhere,
 * then each project and blob), a row per claim with its words first and
 * one quiet line under them, the pinned ones marked and at the head of
 * their scope, and a filter row that fits on one line: words, kind, tag.
 */

export interface KnowledgePageProps {
  facts: FactRow[];
  tags: string[];
  /** The new-claim form is open: its button is the page head's, so the page owns this. */
  adding: boolean;
  onAdding: (open: boolean) => void;
  /** The words searched for: the search box is the page head's, so the page owns them. */
  query: string;
  onQuery: (query: string) => void;
  /** Projects by slug from the manifest, so a project's claims are headed by its name; absent until it is read. */
  projectNames?: ReadonlyMap<string, string>;
  /** Not read yet: a skeleton where the claims will be, never "Nothing remembered yet." */
  loading?: boolean;
  onChanged: () => void;
  /** Says what an action did (Pinned, Forgot), for a toast. */
  onNotice?: (text: string) => void;
}

/** The new-claim form, for its sheet's Create. */
const ADD_FORM = "new-claim-form";

/** Rows a scope shows before "Show all". */
export const SCOPE_FIRST = 8;

/** Who wrote a claim, in a word or two for its row: the drawer says it in full. */
export function sourceWord(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source === "dashboard" || source === "owner") return "you";
  if (source === "agent") return "KOS";
  if (source.startsWith("cron:")) return "a schedule";
  if (source.startsWith("caller:")) return source.slice("caller:".length);
  if (source.startsWith("project:")) return source.slice("project:".length);
  return "a chat";
}

/** A claim's scope, in words. */
export function describeScope(scope: string | undefined): string {
  if (!scope || scope === "global") return "everywhere";
  if (scope.startsWith("project:")) return `project ${scope.slice("project:".length)}`;
  if (scope.startsWith("caller:")) return `the app ${scope.slice("caller:".length)}`;
  return scope;
}

/** Who wrote a claim, in words rather than the id the store keeps. */
export function describeSource(source: string | null | undefined): string {
  if (!source) return "unknown";
  if (source === "dashboard") return "you, here";
  if (source === "chat") return "a chat";
  if (source.startsWith("cron:")) return "a schedule";
  if (source.startsWith("caller:")) return `the app ${source.slice("caller:".length)}`;
  if (source.startsWith("project:")) return `the ${source.slice("project:".length)} orchestrator`;
  return source.replace(/:owner$/, "");
}

export interface ScopeGroup {
  scope: string;
  title: string;
  /** What kind of place it is, beside the title: project, blob, caller. */
  kind: string | null;
  /** A project's slug, when it is one of the owner's projects now: its heading opens it. */
  project?: string;
  /** A project scope whose project is gone or was never made: its slug, shown as one. */
  unknown?: boolean;
  facts: FactRow[];
}

/** Where a scope is, as a heading: everywhere first, then projects, blobs and callers by name. */
function placeOf(scope: string, names: ReadonlyMap<string, string> | undefined): { title: string; kind: string | null; rank: number; project?: string; unknown?: boolean } {
  if (scope === "global") return { title: "Everywhere", kind: null, rank: 0 };
  const blob = /^project:blob:(.+)$/.exec(scope);
  if (blob) return { title: slugWords(blob[1]!), kind: "Blob", rank: 2 };
  if (scope.startsWith("project:")) {
    const slug = scope.slice("project:".length);
    if (!names) return { title: slugWords(slug), kind: "Project", rank: 1 };
    const name = names.get(slug);
    return name ? { title: name, kind: "Project", rank: 1, project: slug } : { title: slug, kind: "No such project", rank: 1, unknown: true };
  }
  if (scope.startsWith("caller:")) return { title: scope.slice("caller:".length), kind: "Other app", rank: 3 };
  // A bare project slug, as some writers keep it: the project by its name.
  const named = names?.get(scope);
  if (named) return { title: named, kind: "Project", rank: 1, project: scope };
  return { title: scope, kind: null, rank: 4 };
}

/**
 * One name for each place a claim can be: a blob's claims are written under
 * either name for it, and a slug passed with its prefix already on it
 * (`project:project:x`, which memory.remember once minted) is the project x.
 */
export function canonicalScope(scope: string | undefined): string {
  return (scope ?? "global").replace(/^agent:/, "project:blob:").replace(/^(?:project:)+/, "project:");
}

/** Claims by where they apply, pinned first in each, then the latest. Without the manifest, no project is called missing. */
export function groupByScope(facts: readonly FactRow[], names?: ReadonlyMap<string, string>): ScopeGroup[] {
  const byScope = new Map<string, FactRow[]>();
  for (const f of facts) {
    const scope = canonicalScope(f.scope);
    byScope.set(scope, [...(byScope.get(scope) ?? []), f]);
  }
  return [...byScope.entries()]
    .map(([scope, list]) => {
      const place = placeOf(scope, names);
      const sorted = [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const { rank, ...where } = place;
      return { group: { scope, ...where, facts: sorted }, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.group.title.localeCompare(b.group.title))
    .map((g) => g.group);
}

/** "all", "pinned", or one kind of claim. */
type KindFilter = string;

const KIND_WORDS: Record<string, string> = { fact: "Facts", preference: "Preferences", decision: "Decisions" };
const FORGET_TEXT = "KOS stops knowing this in every chat. It cannot be undone.";

/**
 * A claim's row is one stop for Tab: its words open it, and the arrow keys
 * walk on to Pin, Edit and Forget and back, so a list of forty claims is
 * forty stops rather than a hundred and sixty. On the row itself, a letter
 * does the action at once: P pins or unpins, E edits, and Delete asks to
 * forget it (the same confirm as the row's ×, so one key never forgets).
 */
export interface ClaimRowActions {
  pin: () => void;
  edit: () => void;
}

export function claimRowKeys(e: KeyboardEvent<HTMLLIElement>, act: ClaimRowActions): void {
  const onRow = e.target instanceof HTMLElement && e.target.classList.contains("know-open");
  if (onRow && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "p" || key === "e") {
      e.preventDefault();
      (key === "p" ? act.pin : act.edit)();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.currentTarget.querySelector<HTMLButtonElement>(".know-acts .confirm-wrap button")?.click();
      return;
    }
  }
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const stops = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const at = stops.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  const next = stops[Math.max(0, Math.min(stops.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)))];
  if (next && next !== stops[at]) {
    e.preventDefault();
    next.focus();
  }
}

/** The most claims an address names: a turn is given a few dozen at most. */
const IDS_MAX = 500;

/** Claims the address names (#/memory?tab=claims&ids=3,7): a turn's memory, opened from its chat. */
function idsInHash(hash: string): ReadonlySet<number> | null {
  const m = /[?&]ids=([\d,]+)/.exec(hash);
  const ids = (m?.[1] ?? "").split(",").filter(Boolean).map(Number).filter(Number.isSafeInteger).slice(0, IDS_MAX);
  return ids.length > 0 ? new Set(ids) : null;
}

function splitTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function KnowledgePage({ facts, tags, adding, onAdding, query, onQuery: setQuery, projectNames, loading = false, onChanged, onNotice }: KnowledgePageProps): ReactElement {
  const kindsRef = useEdgeFade<HTMLDivElement>(".chips");
  const [kind, setKind] = useState<KindFilter>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [only, setOnly] = useState(() => idsInHash(window.location.hash));
  // Named again from outside (a search hit while the page is open): the list follows the address.
  const [ids] = useHashParam("ids");
  useEffect(() => {
    if (ids !== undefined) setOnly(idsInHash(window.location.hash));
  }, [ids]);
  /** Scopes opened past their first few. */
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());
  /** The entry being read in full, which is where its actions live too. */
  const [open, setOpen] = useState<FactRow | null>(null);
  /**
   * The same entry, being changed.
   *
   * An entry is written by the agent and read back on every turn, so a
   * wrong one keeps being acted on. Correcting it meant forgetting it and
   * writing a new one from memory, which loses the tags and the key.
   */
  const [edit, setEdit] = useState<{ key: string; value: string; kind: string; tags: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ key: string; value: string; tags: string }>({ key: "", value: "", tags: "" });

  const startEdit = (f: FactRow): void => {
    setOpen(f);
    setEdit({ key: f.key, value: f.value, kind: f.kind, tags: (f.tags ?? []).join(", ") });
  };
  const togglePin = (f: FactRow): void => {
    void api.pinMemory(f.key, !f.pinned).then(() => {
      setOpen(null);
      onChanged();
      onNotice?.(f.pinned ? `Unpinned ${f.key}` : `Pinned ${f.key}`);
    });
  };
  const forget = (f: FactRow): void => {
    void api.deleteMemory(f.key).then(() => {
      setOpen(null);
      onChanged();
      onNotice?.(`Forgot ${f.key}`);
    });
  };

  async function saveEdit(original: FactRow): Promise<void> {
    if (!edit) return;
    const key = edit.key.trim();
    const value = edit.value.trim();
    if (!key || !value) return;
    setSaving(true);
    try {
      await api.saveMemory(key, value, edit.kind === "preference" ? "preference" : "fact", splitTags(edit.tags));
      /*
       * A changed key is a new entry, so the old one has to go.
       *
       * Written in that order: if the delete came first and the save failed,
       * the entry would be gone and nothing would have replaced it.
       */
      if (key !== original.key) await api.deleteMemory(original.key);
      setEdit(null);
      setOpen(null);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function save(): Promise<void> {
    const key = draft.key.trim();
    const value = draft.value.trim();
    if (!key || !value) return;
    await api.saveMemory(key, value, "fact", splitTags(draft.tags));
    setDraft({ key: "", value: "", tags: "" });
    onAdding(false);
    onChanged();
  }

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of facts) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    return counts;
  }, [facts]);
  const pinnedCount = useMemo(() => facts.filter((f) => f.pinned).length, [facts]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = facts.filter((f) => {
      if (only && (f.id === undefined || !only.has(f.id))) return false;
      if (kind === "pinned" ? !f.pinned : kind !== "all" && f.kind !== kind) return false;
      if (tag && !(f.tags ?? []).includes(tag)) return false;
      if (!q) return true;
      return f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q) || (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
    });
    return groupByScope(matched, projectNames);
  }, [facts, query, kind, tag, only, projectNames]);

  const filtered = query.trim() !== "" || kind !== "all" || tag !== null || only !== null;
  const showAll = (): void => {
    setOnly(null);
    history.replaceState(null, "", hrefFor({ name: "memory" }));
  };
  const clear = (): void => {
    setQuery("");
    setKind("all");
    setTag(null);
    if (only) showAll();
  };

  const kindOptions = [
    ["all", <>All <Count n={facts.length} /></>, "Every claim"] as const,
    ...[...kinds.entries()].map(([k, n]) => [k, <>{KIND_WORDS[k] ?? k} <Count n={n} /></>] as const),
    ...(pinnedCount > 0 ? [["pinned", <>Pinned <Count n={pinnedCount} /></>, "In every conversation"] as const] : []),
  ];

  return (
    <div className="know">
      {facts.length > 0 && (
        <div className="know-bar">
          {only && (
            <Tag title="The claims a turn was given from memory" remove={{ label: "Show every claim", onRemove: showAll }}>
              Recalled for a turn
            </Tag>
          )}
          <div className="know-kinds" ref={kindsRef}>
            <Chips small scroll label="Kind" options={kindOptions} selected={kind} onChoose={(k) => setKind(k === kind ? "all" : k)} />
          </div>
          {tags.length > 0 && (
            <Select
              className="know-tag"
              label="Tag"
              value={tag ?? ""}
              options={[{ value: "", label: "Any tag" }, ...[...tags].sort((a, b) => a.localeCompare(b)).map((t) => ({ value: t, label: t }))]}
              onChange={(v) => setTag(v === "" ? null : v)}
            />
          )}
        </div>
      )}

      <Modal
        open={adding}
        title="New claim"
        size="sm"
        onClose={() => onAdding(false)}
        footer={
          <SheetFoot
            onCancel={() => onAdding(false)}
            {...(!draft.key.trim() || !draft.value.trim() ? { held: draft.key.trim() ? "Say what to remember first." : "Give it a name first." } : {})}
            primary={
              <button type="submit" form={ADD_FORM} className="btn btn--primary" disabled={!draft.key.trim() || !draft.value.trim()}>
                Create
              </button>
            }
          />
        }
      >
        <form
          id={ADD_FORM}
          className="rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Name" required hint="A short name KOS finds it by, such as home city. Saying it again under the same name updates it.">
            <input className="kos-input" autoFocus placeholder="Home city" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
          </Field>
          <Field label="What to remember" required>
            <input className="kos-input" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
          </Field>
          <Field label="Tags" hint="Comma separated.">
            <input className="kos-input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
          </Field>
        </form>
      </Modal>

      {loading && facts.length === 0 && <EmptyState loading className="know-empty" />}
      {!loading && facts.length === 0 && (
        <EmptyState title="Nothing remembered yet." className="know-empty">
          KOS keeps what you tell it and what its agents work out, for every chat to read. Pin what should be in every conversation.{" "}
          <button type="button" className="link" onClick={() => onAdding(true)}>
            Add a claim
          </button>
        </EmptyState>
      )}

      {facts.length > 0 && groups.length === 0 && <EmptyState className="know-none" query={{ noun: "claims", onClear: clear }} />}

      {groups.map((g) => {
        const all = filtered || whole.has(g.scope) || g.facts.length <= SCOPE_FIRST;
        const shown = all ? g.facts : g.facts.slice(0, SCOPE_FIRST);
        return (
          <section key={g.scope} className="know-group" aria-label={g.title}>
            <GroupHead
              count={g.facts.length}
              title={
                <>
                  {g.project ? (
                    <a className="know-group-link" href={hrefFor({ name: "project", slug: g.project })}>
                      {g.title}
                    </a>
                  ) : (
                    <span className={g.unknown ? "know-group-slug" : undefined}>{g.title}</span>
                  )}
                  {g.kind && <span className={`know-group-kind${g.unknown ? " is-unknown" : ""}`}>{g.kind}</span>}
                </>
              }
            />
            <ul className="know-list">
              {shown.map((f) => (
                <li key={f.key} className={`know-row${f.pinned ? " is-pinned" : ""}`} onKeyDown={(e) => claimRowKeys(e, { pin: () => togglePin(f), edit: () => startEdit(f) })}>
                  <button type="button" className="know-open" aria-keyshortcuts="ArrowRight P E Delete" onClick={() => setOpen(f)}>
                    <span className="know-text">
                      {f.pinned && (
                        <span className="know-pin">
                          <PinIcon size={12} title="Pinned: in every conversation" />
                        </span>
                      )}
                      <span className="know-value">{f.value}</span>
                    </span>
                    <span className="know-meta">
                      <span className="know-key" title={f.key}>{slugWords(f.key)}</span>
                      {sourceWord(f.source) && <span className="know-from">from {sourceWord(f.source)}</span>}
                      {f.kind !== "fact" && <Tag>{kindWord(f.kind)}</Tag>}
                      {(f.tags ?? []).length > 0 && <span className="know-tags">{f.tags!.join(", ")}</span>}
                      {f.updatedAt ? <span className="know-when">{timeWords(f.updatedAt)}</span> : null}
                    </span>
                  </button>
                  <span className="know-acts">
                    <IconButton tabIndex={-1} label={f.pinned ? `Unpin ${slugWords(f.key)}` : `Pin ${slugWords(f.key)}`} title={f.pinned ? "Unpin" : "Pin to every conversation"} onClick={() => togglePin(f)}>
                      {f.pinned ? <UnpinIcon size={14} title="" /> : <PinIcon size={14} title="" />}
                    </IconButton>
                    <IconButton tabIndex={-1} label={`Edit ${slugWords(f.key)}`} title="Edit" onClick={() => startEdit(f)}>
                      <EditIcon size={14} title="" />
                    </IconButton>
                    <ConfirmButton
                      label={`Forget ${slugWords(f.key)}`}
                      title="Forget"
                      tabIndex={-1}
                      icon={<CloseIcon size={14} title="" />}
                      className="icon-btn icon-btn--danger"
                      text={FORGET_TEXT}
                      confirmLabel="Forget"
                      onConfirm={() => forget(f)}
                    />
                  </span>
                </li>
              ))}
            </ul>
            {!filtered && g.facts.length > SCOPE_FIRST && (
              <button
                type="button"
                className="btn btn--sm btn--ghost know-more"
                onClick={() =>
                  setWhole((s) => {
                    const next = new Set(s);
                    if (!next.delete(g.scope)) next.add(g.scope);
                    return next;
                  })
                }
              >
                {whole.has(g.scope) ? "Show fewer" : `Show all ${g.facts.length}`}
              </button>
            )}
          </section>
        );
      })}

      <Drawer
        open={open !== null}
        title={open ? slugWords(open.key) : ""}
        {...(open ? { subtitle: [kindWord(open.kind), describeScope(open.scope), open.updatedAt ? `updated ${timeWords(open.updatedAt)}` : null].filter(Boolean).join(" · ") } : {})}
        onClose={() => {
          setOpen(null);
          setEdit(null);
        }}
        footer={
          open &&
          (edit ? (
            <SheetFoot
              onCancel={() => setEdit(null)}
              primary={
                <button type="button" className="btn btn--primary" disabled={saving || !edit.key.trim() || !edit.value.trim()} onClick={() => void saveEdit(open)}>
                  {saving ? "Saving…" : "Save"}
                </button>
              }
            />
          ) : (
            <SheetFoot
              danger={<ConfirmButton label="Forget" className="btn btn--danger" text={FORGET_TEXT} onConfirm={() => forget(open)} />}
              primary={
                <>
                  <button type="button" className="btn" onClick={() => togglePin(open)}>
                    {open.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => startEdit(open)}>
                    Edit
                  </button>
                </>
              }
            />
          ))
        }
      >
        {open && edit && (
          <div className="know-detail">
            <label className="kos-field">
              <span className="kos-field-label">Name</span>
              <input className="kos-input" value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} />
              <span className="hint">What KOS finds it by. Changing it keeps it under the new name and forgets the old one.</span>
            </label>
            <label className="kos-field">
              <span className="kos-field-label">Value</span>
              <textarea className="kos-input" rows={10} value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
            </label>
            <label className="kos-field">
              <span className="kos-field-label">Kind</span>
              <Select
                className="settings-select"
                label="Kind"
                value={edit.kind}
                options={[
                  { value: "fact", label: "Fact", hint: "something that is so" },
                  { value: "preference", label: "Preference", hint: "how the owner wants things done" },
                ]}
                onChange={(v) => setEdit({ ...edit, kind: v })}
              />
            </label>
            <label className="kos-field">
              <span className="kos-field-label">Tags</span>
              <input className="kos-input" placeholder="comma separated" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} />
            </label>
          </div>
        )}
        {open && !edit && (
          <div className="know-detail">
            {/* The whole of it: the row shows one line. */}
            <p className="know-detail-value">{open.value}</p>
            <dl className="know-detail-rows">
              <dt>Name</dt>
              <dd title={open.key}>{slugWords(open.key)}</dd>
              <dt>Kind</dt>
              <dd>{kindWord(open.kind)}</dd>
              <dt>Tags</dt>
              <dd>
                {(open.tags ?? []).length ? (
                  <Chips
                    small
                    options={open.tags!.map((t) => [t, t] as const)}
                    onChoose={(t) => {
                      setTag(t);
                      setOpen(null);
                    }}
                  />
                ) : (
                  <span className="ops-muted">none</span>
                )}
              </dd>
              <dt>Where it applies</dt>
              <dd>{describeScope(open.scope)}</dd>
              <dt>Written by</dt>
              <dd>{describeSource(open.source)}</dd>
              <dt>Pinned</dt>
              <dd>{open.pinned ? "yes, in every conversation" : "no"}</dd>
            </dl>
          </div>
        )}
      </Drawer>
    </div>
  );
}
