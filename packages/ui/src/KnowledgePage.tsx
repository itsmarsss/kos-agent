import { useMemo, useState, type ReactElement } from "react";

import { api, type FactRow } from "./api.js";
import { Drawer } from "./Drawer.js";
import { Select } from "./Select.js";
import { PageHead } from "./PageHead.js";

/** How long ago, in the words the rest of the dashboard uses. */
function relative(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Knowledge: what KOS and every conversation know.
 *
 * This used to be a table of preferences, which undersold it. It is the one
 * place state outlives a conversation, so it is shown as what it is: pinned
 * things first, then grouped by tag, each entry saying which conversation
 * wrote it so a wrong belief can be traced to where it came from.
 */

export interface KnowledgePageProps {
  facts: FactRow[];
  tags: string[];
  onChanged: () => void;
}

const UNTAGGED = "untagged";

export function KnowledgePage({
  facts,
  tags,
  onChanged,
}: KnowledgePageProps): ReactElement {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  /** The entry being read in full, which is where its actions live too. */
  const [open, setOpen] = useState<FactRow | null>(null);
  /**
   * The same entry, being changed.
   *
   * An entry is written by the agent and read back on every turn, so a
   * wrong one keeps being acted on. Correcting it meant forgetting it and
   * writing a new one from memory, which loses the tags and the key.
   */
  const [edit, setEdit] = useState<{
    key: string;
    value: string;
    kind: string;
    tags: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  async function saveEdit(original: FactRow): Promise<void> {
    if (!edit) return;
    const key = edit.key.trim();
    const value = edit.value.trim();
    if (!key || !value) return;
    setSaving(true);
    try {
      const tags = edit.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await api.saveMemory(
        key,
        value,
        edit.kind === "preference" ? "preference" : "fact",
        tags,
      );
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
  const [draft, setDraft] = useState<{ key: string; value: string; tags: string }>({
    key: "",
    value: "",
    tags: "",
  });
  const [adding, setAdding] = useState(false);

  const { pinned, groups } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = facts.filter((f) => {
      if (tag && !(f.tags ?? []).includes(tag)) return false;
      if (!q) return true;
      return (
        f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q)
      );
    });

    const pin = matched.filter((f) => f.pinned);
    const rest = matched.filter((f) => !f.pinned);

    // Grouped by tag, an entry carrying two tags was listed under each one and
    // read as two separate entries. Grouping only holds when a tag is chosen,
    // and there the heading is the tag you already picked, so it earns nothing.
    if (tag) return { pinned: pin, groups: [[tag, rest] as const] };

    const byTag = new Map<string, FactRow[]>();
    for (const f of rest) {
      const key = (f.tags ?? [])[0] ?? UNTAGGED;
      byTag.set(key, [...(byTag.get(key) ?? []), f]);
    }
    return {
      pinned: pin,
      groups: [...byTag.entries()].sort((a, b) =>
        a[0] === UNTAGGED ? 1 : b[0] === UNTAGGED ? -1 : a[0].localeCompare(b[0]),
      ),
    };
  }, [facts, query, tag]);

  async function save(): Promise<void> {
    const key = draft.key.trim();
    const value = draft.value.trim();
    if (!key || !value) return;
    const list = draft.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    await api.saveMemory(key, value, "fact", list);
    setDraft({ key: "", value: "", tags: "" });
    setAdding(false);
    onChanged();
  }

  /*
   * A card opens what it is about.
   *
   * An entry is a paragraph the agent wrote and reads back on every turn, so
   * the row was showing the whole of it and running to a dozen lines. It
   * shows the first few now and the rest is a click away, along with the
   * things worth doing to it -- which were two buttons squeezed against the
   * right edge of a wall of text.
   */
  function entry(f: FactRow): ReactElement {
    return (
      <button
        key={f.key}
        type="button"
        className="know-item"
        onClick={() => setOpen(f)}
      >
        <span className="know-main">
          <span className="know-key">{f.key}</span>
          <span className="know-value">{f.value}</span>
          <span className="know-meta">
            {f.kind}
            {f.source ? ` · from ${f.source.replace(/:owner$/, "")}` : ""}
            {(f.tags ?? []).length ? ` · ${f.tags!.join(", ")}` : ""}
          </span>
        </span>
        {f.pinned && (
          <span className="know-pinned" title="In every conversation">
            pinned
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="know">
      <PageHead
        title="Claims"
        subtitle="What KOS believes: shared by every conversation, scoped to a project or to you everywhere, each with where it came from."
        search={
          <input
            className="list-search"
            value={query}
            placeholder="Search claims…"
            onChange={(e) => setQuery(e.target.value)}
          />
        }
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "Cancel" : "New fact"}
          </button>
        }
      />

      {adding && (
        <div className="know-add">
          <input
            className="chats-search"
            placeholder="key, e.g. deploy_target"
            value={draft.key}
            onChange={(e) => setDraft({ ...draft, key: e.target.value })}
          />
          <input
            className="chats-search"
            placeholder="what to remember"
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          />
          <input
            className="chats-search"
            placeholder="tags, comma separated"
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
          <button type="button" className="btn btn--primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      )}

      {tags.length > 0 && (
        <div className="know-tags">
          <button
            type="button"
            className={`chip ${tag === null ? "is-on" : ""}`}
            onClick={() => setTag(null)}
          >
            all
          </button>
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip ${tag === t ? "is-on" : ""}`}
              onClick={() => setTag(tag === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {facts.length === 0 && (
        <p className="hint">
          Nothing yet. KOS records what you tell it, and agents add what they
          work out.
        </p>
      )}

      <Drawer
        open={open !== null}
        title={open?.key ?? ""}
        {...(open
          ? {
              subtitle: [
                open.kind,
                open.source ? `from ${open.source.replace(/:owner$/, "")}` : null,
                open.updatedAt ? `updated ${relative(open.updatedAt)}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            }
          : {})}
        onClose={() => {
          setOpen(null);
          setEdit(null);
        }}
        footer={
          open &&
          (edit ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={saving || !edit.key.trim() || !edit.value.trim()}
                onClick={() => void saveEdit(open)}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn" onClick={() => setEdit(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  setEdit({
                    key: open.key,
                    value: open.value,
                    kind: open.kind,
                    tags: (open.tags ?? []).join(", "),
                  })
                }
              >
                Edit
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void api.pinMemory(open.key, !open.pinned).then(() => {
                    setOpen(null);
                    onChanged();
                  });
                }}
              >
                {open.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={() => {
                  void api.deleteMemory(open.key).then(() => {
                    setOpen(null);
                    onChanged();
                  });
                }}
              >
                Forget
              </button>
            </>
          ))
        }
      >
        {open && edit && (
          <div className="know-detail">
            <label className="kos-field">
              <span className="kos-field-label">Key</span>
              <input
                className="kos-input kos-mono"
                value={edit.key}
                onChange={(e) => setEdit({ ...edit, key: e.target.value })}
              />
              <span className="hint">
                What the agent looks it up by. Changing it writes the entry
                under the new name and forgets the old one.
              </span>
            </label>
            <label className="kos-field">
              <span className="kos-field-label">Value</span>
              <textarea
                className="kos-input"
                rows={10}
                value={edit.value}
                onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              />
            </label>
            <label className="kos-field">
              <span className="kos-field-label">Kind</span>
              <Select
                className="settings-select"
                label="Kind"
                value={edit.kind}
                options={[
                  { value: "fact", label: "Fact", hint: "something that is so" },
                  {
                    value: "preference",
                    label: "Preference",
                    hint: "how the owner wants things done",
                  },
                ]}
                onChange={(v) => setEdit({ ...edit, kind: v })}
              />
            </label>
            <label className="kos-field">
              <span className="kos-field-label">Tags</span>
              <input
                className="kos-input"
                placeholder="comma separated"
                value={edit.tags}
                onChange={(e) => setEdit({ ...edit, tags: e.target.value })}
              />
            </label>
          </div>
        )}
        {open && !edit && (
          <div className="know-detail">
            {/* The whole of it. The card shows the first few lines, which is
                where the value of a long entry stops being readable. */}
            <p className="know-detail-value">{open.value}</p>
            <dl className="know-detail-rows">
              <dt>Key</dt>
              <dd className="kos-mono">{open.key}</dd>
              <dt>Kind</dt>
              <dd>{open.kind}</dd>
              <dt>Tags</dt>
              <dd>
                {(open.tags ?? []).length ? (
                  <span className="know-detail-tags">
                    {open.tags!.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="chip"
                        onClick={() => {
                          setTag(t);
                          setOpen(null);
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </span>
                ) : (
                  <span className="ops-muted">none</span>
                )}
              </dd>
              <dt>Written by</dt>
              <dd>{open.source ? open.source.replace(/:owner$/, "") : "unknown"}</dd>
              <dt>In every conversation</dt>
              <dd>{open.pinned ? "yes" : "no"}</dd>
            </dl>
          </div>
        )}
      </Drawer>

      {pinned.length > 0 && (
        <section className="know-group">
          <h2>
            Always in context<span className="projects-count">{pinned.length}</span>
          </h2>
          {pinned.map(entry)}
        </section>
      )}

      {groups.map(([name, items]) => (
        <section key={name} className="know-group">
          <h2>
            {name}
            <span className="projects-count">{items.length}</span>
          </h2>
          {items.map(entry)}
        </section>
      ))}
    </div>
  );
}
