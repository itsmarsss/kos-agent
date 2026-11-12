import { useMemo, useState, type ReactElement } from "react";

import { Chips, CloseIcon, Count, EditIcon, Empty, IconButton, PinIcon, SearchIcon, Tag, UnpinIcon } from "@kos/kit";

import { api, type FactRow } from "./api.js";
import { Drawer } from "./Drawer.js";
import { ConfirmButton } from "./kit.js";
import { agoWords } from "./schedulewords.js";
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
  /** Projects by slug, so a project's claims are headed by its name. */
  projectNames?: ReadonlyMap<string, string>;
  onChanged: () => void;
}

/** Rows a scope shows before "Show all". */
export const SCOPE_FIRST = 8;

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** A claim's scope, in words. */
export function describeScope(scope: string | undefined): string {
  if (!scope || scope === "global") return "everywhere";
  if (scope.startsWith("project:")) return `project ${scope.slice("project:".length)}`;
  if (scope.startsWith("caller:")) return `caller ${scope.slice("caller:".length)}`;
  return scope;
}

/** Who wrote a claim, in words rather than the id the store keeps. */
export function describeSource(source: string | null | undefined): string {
  if (!source) return "unknown";
  if (source === "dashboard") return "you, here";
  if (source === "chat") return "a chat";
  if (source.startsWith("cron:")) return `a scheduled job (#${source.slice("cron:".length)})`;
  if (source.startsWith("caller:")) return `the ${source.slice("caller:".length)} caller`;
  if (source.startsWith("project:")) return `the ${source.slice("project:".length)} orchestrator`;
  return source.replace(/:owner$/, "");
}

export interface ScopeGroup {
  scope: string;
  title: string;
  /** What kind of place it is, beside the title: project, blob, caller. */
  kind: string | null;
  facts: FactRow[];
}

/** Where a scope is, as a heading: everywhere first, then projects, blobs and callers by name. */
function placeOf(scope: string, names: ReadonlyMap<string, string>): { title: string; kind: string | null; rank: number } {
  if (scope === "global") return { title: "Everywhere", kind: null, rank: 0 };
  const blob = /^project:blob:(.+)$/.exec(scope);
  if (blob) return { title: blob[1]!, kind: "blob", rank: 2 };
  if (scope.startsWith("project:")) {
    const slug = scope.slice("project:".length);
    return { title: names.get(slug) ?? slug, kind: "project", rank: 1 };
  }
  if (scope.startsWith("caller:")) return { title: scope.slice("caller:".length), kind: "caller", rank: 3 };
  return { title: scope, kind: null, rank: 4 };
}

/** Claims by where they apply, pinned first in each, then the latest. */
export function groupByScope(facts: readonly FactRow[], names: ReadonlyMap<string, string> = NO_NAMES): ScopeGroup[] {
  const byScope = new Map<string, FactRow[]>();
  for (const f of facts) {
    // A blob's claims are written under either name for it; they are one place.
    const scope = (f.scope ?? "global").replace(/^agent:/, "project:blob:");
    byScope.set(scope, [...(byScope.get(scope) ?? []), f]);
  }
  return [...byScope.entries()]
    .map(([scope, list]) => {
      const place = placeOf(scope, names);
      const sorted = [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      return { group: { scope, title: place.title, kind: place.kind, facts: sorted }, rank: place.rank };
    })
    .sort((a, b) => a.rank - b.rank || a.group.title.localeCompare(b.group.title))
    .map((g) => g.group);
}

/** "all", "pinned", or one kind of claim. */
type KindFilter = string;

const KIND_WORDS: Record<string, string> = { fact: "Facts", preference: "Preferences", decision: "Decisions" };
const FORGET_TEXT = "KOS stops knowing this in every chat. It cannot be undone.";

function splitTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function KnowledgePage({ facts, tags, projectNames = NO_NAMES, onChanged }: KnowledgePageProps): ReactElement {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [tag, setTag] = useState<string | null>(null);
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
  const [adding, setAdding] = useState(false);

  const startEdit = (f: FactRow): void => {
    setOpen(f);
    setEdit({ key: f.key, value: f.value, kind: f.kind, tags: (f.tags ?? []).join(", ") });
  };
  const togglePin = (f: FactRow): void => {
    void api.pinMemory(f.key, !f.pinned).then(() => {
      setOpen(null);
      onChanged();
    });
  };
  const forget = (f: FactRow): void => {
    void api.deleteMemory(f.key).then(() => {
      setOpen(null);
      onChanged();
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
    setAdding(false);
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
      if (kind === "pinned" ? !f.pinned : kind !== "all" && f.kind !== kind) return false;
      if (tag && !(f.tags ?? []).includes(tag)) return false;
      if (!q) return true;
      return f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q) || (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
    });
    return groupByScope(matched, projectNames);
  }, [facts, query, kind, tag, projectNames]);

  const filtered = query.trim() !== "" || kind !== "all" || tag !== null;
  const clear = (): void => {
    setQuery("");
    setKind("all");
    setTag(null);
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
          <label className="know-search">
            <SearchIcon size={14} title="" />
            <input type="search" value={query} placeholder="Search claims…" aria-label="Search claims" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <Chips small label="Kind" options={kindOptions} selected={kind} onChoose={(k) => setKind(k === kind ? "all" : k)} />
          {tags.length > 0 && (
            <Select
              className="know-tag"
              label="Tag"
              value={tag ?? ""}
              options={[{ value: "", label: "Any tag" }, ...[...tags].sort((a, b) => a.localeCompare(b)).map((t) => ({ value: t, label: t }))]}
              onChange={(v) => setTag(v === "" ? null : v)}
            />
          )}
          <button type="button" className="btn btn--primary know-new" onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "New claim"}
          </button>
        </div>
      )}

      {adding && (
        <form
          className="know-add"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input className="kos-input kos-mono" aria-label="Key" placeholder="key, e.g. deploy_target" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
          <input className="kos-input" aria-label="What to remember" placeholder="what to remember" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
          <input className="kos-input" aria-label="Tags" placeholder="tags, comma separated" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
          <button type="submit" className="btn btn--primary" disabled={!draft.key.trim() || !draft.value.trim()}>
            Save
          </button>
        </form>
      )}

      {facts.length === 0 && !adding && (
        <Empty title="Nothing remembered yet." className="know-empty">
          KOS keeps what you tell it and what its agents work out, for every chat to read. Pin what should be in every conversation.{" "}
          <button type="button" className="link" onClick={() => setAdding(true)}>
            Add a claim
          </button>
        </Empty>
      )}

      {facts.length > 0 && groups.length === 0 && (
        <Empty title="No claims match." className="know-none">
          Nothing in memory fits these words and filters.{" "}
          <button type="button" className="link" onClick={clear}>
            Clear the filters
          </button>
        </Empty>
      )}

      {groups.map((g) => {
        const all = filtered || whole.has(g.scope) || g.facts.length <= SCOPE_FIRST;
        const shown = all ? g.facts : g.facts.slice(0, SCOPE_FIRST);
        return (
          <section key={g.scope} className="know-group" aria-label={g.title}>
            <h2 className="know-group-title">
              {g.title}
              {g.kind && <span className="know-group-kind">{g.kind}</span>}
              <Count n={g.facts.length} />
            </h2>
            <ul className="know-list">
              {shown.map((f) => (
                <li key={f.key} className={`know-row${f.pinned ? " is-pinned" : ""}`}>
                  <button type="button" className="know-open" onClick={() => setOpen(f)}>
                    <span className="know-text">
                      {f.pinned && (
                        <span className="know-pin">
                          <PinIcon size={12} title="Pinned: in every conversation" />
                        </span>
                      )}
                      <span className="know-value">{f.value}</span>
                    </span>
                    <span className="know-meta">
                      <code className="know-key">{f.key}</code>
                      {f.kind !== "fact" && <Tag>{f.kind}</Tag>}
                      {(f.tags ?? []).length > 0 && <span className="know-tags">{f.tags!.join(", ")}</span>}
                      {f.updatedAt ? <span className="know-when">{agoWords(f.updatedAt)}</span> : null}
                    </span>
                  </button>
                  <span className="know-acts">
                    <IconButton label={f.pinned ? `Unpin ${f.key}` : `Pin ${f.key}`} title={f.pinned ? "Unpin" : "Pin to every conversation"} onClick={() => togglePin(f)}>
                      {f.pinned ? <UnpinIcon size={14} title="" /> : <PinIcon size={14} title="" />}
                    </IconButton>
                    <IconButton label={`Edit ${f.key}`} title="Edit" onClick={() => startEdit(f)}>
                      <EditIcon size={14} title="" />
                    </IconButton>
                    <ConfirmButton
                      label={`Forget ${f.key}`}
                      title="Forget"
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
        title={open?.key ?? ""}
        {...(open ? { subtitle: [open.kind, describeScope(open.scope), open.updatedAt ? `updated ${agoWords(open.updatedAt)}` : null].filter(Boolean).join(" · ") } : {})}
        onClose={() => {
          setOpen(null);
          setEdit(null);
        }}
        footer={
          open &&
          (edit ? (
            <>
              <button type="button" className="btn btn--primary" disabled={saving || !edit.key.trim() || !edit.value.trim()} onClick={() => void saveEdit(open)}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn" onClick={() => setEdit(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--primary" onClick={() => startEdit(open)}>
                Edit
              </button>
              <button type="button" className="btn" onClick={() => togglePin(open)}>
                {open.pinned ? "Unpin" : "Pin"}
              </button>
              <ConfirmButton label="Forget" className="btn btn--danger" text={FORGET_TEXT} onConfirm={() => forget(open)} />
            </>
          ))
        }
      >
        {open && edit && (
          <div className="know-detail">
            <label className="kos-field">
              <span className="kos-field-label">Key</span>
              <input className="kos-input kos-mono" value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} />
              <span className="hint">What the agent looks it up by. Changing it writes the entry under the new name and forgets the old one.</span>
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
              <dt>Key</dt>
              <dd className="kos-mono">{open.key}</dd>
              <dt>Kind</dt>
              <dd>{open.kind}</dd>
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
