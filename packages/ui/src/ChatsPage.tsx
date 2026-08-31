import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { api, type ChatTurn, type Conversation } from "./api.js";
import { hrefFor } from "./routes.js";

/**
 * The chats page: a list that stays usable at fifty conversations, and the
 * selected one open beside it. Tabs in a slide-over stopped working somewhere
 * around five, which is why this exists as its own place rather than more
 * chrome bolted onto the panel.
 */

export interface ChatsPageProps {
  conversations: Conversation[];
  activeId?: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
}

function relative(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function ChatsPage({
  conversations,
  activeId,
  onOpen,
  onChanged,
}: ChatsPageProps): ReactElement {
  const [query, setQuery] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const loaded = useRef<string | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId);

  useEffect(() => {
    if (!activeId || loaded.current === activeId) return;
    loaded.current = activeId;
    let cancelled = false;
    void api
      .conversation(activeId)
      .then(({ messages }) => !cancelled && setTurns(messages))
      .catch(() => !cancelled && setTurns([]));
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [turns, sending]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || sending || !activeId) return;
    setSending(true);
    setTurns((t) => [...t, { role: "you", text }]);
    setDraft("");
    try {
      const res = await api.message(text, activeId);
      setTurns((t) => [...t, { role: "kos", text: res.reply || "(no reply)" }]);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTurns((t) => [...t, { role: "kos", text: `Error: ${msg}` }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chats">
      <aside className="chats-list">
        <div className="chats-list-head">
          <input
            className="chats-search"
            value={query}
            placeholder="Search chats…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul>
          {filtered.map((c) => (
            <li key={c.id}>
              <a
                className={`chats-item ${c.id === activeId ? "is-active" : ""}`}
                href={hrefFor({ name: "chats", id: c.id })}
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(c.id);
                }}
              >
                <span className="chats-item-top">
                  <span className="chats-item-title">{c.title}</span>
                  <span className="chats-item-when">{relative(c.updatedAt)}</span>
                </span>
                {c.brief && <span className="chats-item-brief">{c.brief}</span>}
                {c.toolAllow.length > 0 && (
                  <span className="chats-item-tools">
                    {c.toolAllow.join(" · ")}
                  </span>
                )}
              </a>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="chats-empty">
              {conversations.length === 0
                ? "No chats yet. Press ⌘K and say what you want to work on."
                : "Nothing matches."}
            </li>
          )}
        </ul>
      </aside>

      <section className="chats-view">
        {!active ? (
          <div className="chats-placeholder">
            <p>Pick a chat, or press ⌘K to start one.</p>
          </div>
        ) : (
          <>
            <header className="chats-view-head">
              <div>
                <h1>{active.title}</h1>
                {active.brief && <p className="chats-brief">{active.brief}</p>}
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  void api.archiveConversation(active.id).then(onChanged);
                }}
              >
                Archive
              </button>
            </header>

            <div className="chats-thread" ref={boxRef}>
              {turns.length === 0 && (
                <p className="hint">Nothing said yet.</p>
              )}
              {turns.map((m, i) => (
                <div key={i} className={`bubble bubble--${m.role}`}>
                  {m.text}
                </div>
              ))}
              {sending && <div className="bubble bubble--kos is-thinking">thinking…</div>}
            </div>

            <div className="chats-composer">
              <textarea
                rows={3}
                value={draft}
                placeholder={`Message ${active.title}…`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="sheet-composer-bar">
                <span className="hint">⌘↵ to send</span>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void send()}
                  disabled={sending || draft.trim() === ""}
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
