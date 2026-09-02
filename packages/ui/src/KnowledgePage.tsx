import { useMemo, useState, type ReactElement } from "react";

import { api, type FactRow } from "./api.js";
import { PageHead } from "./PageHead.js";

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

  function entry(f: FactRow): ReactElement {
    return (
      <div key={f.key} className="know-item">
        <div className="know-main">
          <span className="know-key">{f.key}</span>
          <span className="know-value">{f.value}</span>
          <span className="know-meta">
            {f.kind}
            {f.source ? ` · from ${f.source.replace(/:owner$/, "")}` : ""}
            {(f.tags ?? []).length ? ` · ${f.tags!.join(", ")}` : ""}
          </span>
        </div>
        <div className="know-actions">
          <button
            type="button"
            className={`chip ${f.pinned ? "is-on" : ""}`}
            title={f.pinned ? "Unpin" : "Pin into every conversation"}
            onClick={() => {
              void api.pinMemory(f.key, !f.pinned).then(onChanged);
            }}
          >
            {f.pinned ? "pinned" : "pin"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              void api.deleteMemory(f.key).then(onChanged);
            }}
          >
            Forget
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="know">
      <PageHead
        title="Knowledge"
        subtitle="Shared across every conversation. Agents read this and write to it."
        search={
          <input
            className="list-search"
            value={query}
            placeholder="Search knowledge…"
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
