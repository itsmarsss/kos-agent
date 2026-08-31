import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { api, type ChatEvent, type Conversation } from "./api.js";
import { AttachmentBar, useAttachments } from "./Attachments.js";
import { useProgress } from "./progress.js";
import { ToolCall } from "./ToolCall.js";
import { ChatConfig } from "./ChatConfig.js";
import { Markdown } from "./Markdown.js";
import { Modal } from "./Modal.js";
import { hrefFor } from "./routes.js";
import { composerKeyDown, useStickToBottom } from "./composer.js";

/**
 * The chats page: a list that stays usable at fifty conversations, and the
 * selected one open beside it. Tabs in a slide-over stopped working somewhere
 * around five, which is why this exists as its own place rather than more
 * chrome bolted onto the panel.
 */

export interface ChatsPageProps {
  conversations: Conversation[];
  activeId?: string;
  /** Pending-action ids still awaiting a decision. */
  pendingApprovals: Set<string>;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDecide: (pendingId: string, approved: boolean) => void;
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
  pendingApprovals,
  onOpen,
  onChanged,
  onDecide,
}: ChatsPageProps): ReactElement {
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [showTools, setShowTools] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const attachments = useAttachments();
  const progress = useProgress();
  const loaded = useRef<string | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId);
  const visible = showTools ? events : events.filter((e) => e.kind !== "tool");
  const toolCount = events.filter((e) => e.kind === "tool").length;
  const msgCount = events.length - toolCount;

  /**
   * Reload on the conversation changing, and again whenever it has moved on
   * the server. A transcript loaded once goes stale the moment anything writes
   * to it from outside this view: an approval resuming the agent, work
   * dispatched into it, a message arriving over Discord. Keying on updatedAt
   * means one poll upstream keeps every open thread current.
   */
  const stamp = active?.updatedAt;
  useEffect(() => {
    if (!activeId) return;
    const key = `${activeId}:${stamp ?? 0}`;
    // Mid-send the optimistic bubble is the only record of what was typed.
    if (sending || loaded.current === key) return;
    if (loaded.current?.startsWith(`${activeId}:`) !== true) setEditing(false);
    loaded.current = key;
    let cancelled = false;
    void api
      .conversation(activeId)
      .then(({ events: got }) => !cancelled && setEvents(got))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [activeId, stamp, sending]);

  useStickToBottom(boxRef, [events, sending, activeId]);

  // The orchestrator lives above the list: it is how work gets routed, not one
  // of the threads the routing produces.
  const orchestrator = conversations.find((c) => c.kind === "orchestrator");
  const filtered = useMemo(() => {
    const chats = conversations.filter((c) => c.kind !== "orchestrator");
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  async function send(): Promise<void> {
    const text = draft.trim();
    if ((!text && attachments.files.length === 0) || sending || !activeId) return;
    setSending(true);
    setEvents((e) => [...e, { kind: "message", role: "you", text }]);
    setDraft("");
    try {
      await api.message(text, activeId, attachments.files);
      attachments.clear();
      // Reload rather than appending the reply: the turn may have made tool
      // calls, and those belong in the transcript too.
      const { events: got } = await api.conversation(activeId);
      setEvents(got);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEvents((e) => [...e, { kind: "message", role: "kos", text: `Error: ${msg}` }]);
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
        {orchestrator && (
          <div className="chats-pinned">
            <a
              className={`chats-item chats-item--pinned ${
                orchestrator.id === activeId ? "is-active" : ""
              }`}
              href={hrefFor({ name: "chats", id: orchestrator.id })}
              onClick={(e) => {
                e.preventDefault();
                onOpen(orchestrator.id);
              }}
            >
              <span className="chats-item-top">
                <span className="chats-item-title">{orchestrator.title}</span>
                <span className="chats-badge">⌘K</span>
              </span>
              <span className="chats-item-brief">Routes work across your chats</span>
            </a>
          </div>
        )}

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
                  {/* A thread mid-turn or sitting on an approval looked
                      exactly like an idle one, and the only way to find out
                      was to open it. */}
                  {progress[c.id] ? (
                    <span className="chats-flag chats-flag--working">
                      {progress[c.id]}
                    </span>
                  ) : c.activity && c.activity !== "idle" ? (
                    <span className={`chats-flag chats-flag--${c.activity}`}>
                      {c.activity === "working" ? "working" : "needs you"}
                    </span>
                  ) : (
                    <span className="chats-item-when">{relative(c.updatedAt)}</span>
                  )}
                </span>
                {c.brief && <span className="chats-item-brief">{c.brief}</span>}
                {c.toolAllow !== null && (
                  <span className="chats-item-tools">
                    {c.toolAllow.length === 0 ? "no tools" : c.toolAllow.join(" · ")}
                  </span>
                )}
              </a>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="chats-empty">
              {query.trim() ? "Nothing matches." : "No chats yet. Ask Command to start one."}
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
              <div className="chats-view-title">
                <h1>{active.title}</h1>
                {active.brief && <p className="chats-brief">{active.brief}</p>}
                <div className="chats-meta">
                  <span>{toolCount} tool call{toolCount === 1 ? "" : "s"}</span>
                  <span>·</span>
                  <span>{msgCount} message{msgCount === 1 ? "" : "s"}</span>
                  <span>·</span>
                  <span>
                    {active.toolAllow === null
                      ? "full toolkit"
                      : active.toolAllow.length === 0
                        ? "no tools"
                        : `scoped to ${active.toolAllow.join(", ")}`}
                  </span>
                  {active.channel && (
                    <>
                      <span>·</span>
                      <span>started in {active.channel}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="chats-view-actions">
                <label className="toggle" title="Show tool calls in the transcript">
                  <input
                    type="checkbox"
                    checked={showTools}
                    onChange={(e) => setShowTools(e.target.checked)}
                  />
                  Tool calls
                </label>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setEditing((v) => !v)}
                >
                  {editing ? "Close" : "Configure"}
                </button>
                {active.kind !== "orchestrator" && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      void api.archiveConversation(active.id).then(onChanged);
                    }}
                  >
                    Archive
                  </button>
                )}
              </div>
            </header>

            <Modal
              open={editing}
              title={`Configure “${active.title}”`}
              onClose={() => setEditing(false)}
            >
              <ChatConfig
                key={active.id}
                conversation={active}
                onSaved={onChanged}
                onClose={() => setEditing(false)}
              />
            </Modal>

            <div className="chats-thread" ref={boxRef}>
              {visible.length === 0 && <p className="hint">Nothing said yet.</p>}
              {visible.map((e, i) =>
                e.kind === "tool" ? (
                  <ToolCall
                    key={i}
                    event={e}
                    awaitingApproval={
                      e.pendingId !== undefined && pendingApprovals.has(e.pendingId)
                    }
                    onDecide={onDecide}
                  />
                ) : (
                  <div key={i} className={`bubble bubble--${e.role}`}>
                    {e.images?.map((src, n) => (
                      <img className="bubble-image" key={n} src={src} alt="" />
                    ))}
                    {e.text && <Markdown text={e.text} />}
                  </div>
                ),
              )}
              {(sending || (activeId && progress[activeId])) && (
                <div className="bubble bubble--kos is-thinking">
                  {(activeId && progress[activeId]) ?? "thinking"}…
                </div>
              )}
            </div>

            <div className="chats-composer">
              <AttachmentBar
                files={attachments.files}
                onAdd={(l) => void attachments.add(l)}
                onRemove={attachments.remove}
              />
              <textarea
                rows={3}
                value={draft}
                placeholder={`Message ${active.title}…`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => composerKeyDown(e, () => void send())}
              />
              <div className="sheet-composer-bar">
                <span className="hint">Enter to send · Shift+Enter for a new line</span>
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
