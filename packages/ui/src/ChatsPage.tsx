import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { api, type ChatEvent, type Conversation } from "./api.js";
import { AttachButton, useAttachments, useDropZone } from "./Attachments.js";
import { AttachmentStrip } from "./AttachmentStrip.js";
import { ModelPicker } from "./ModelPicker.js";
import { HighlightedInput } from "./HighlightedInput.js";
import {
  applySuggestion,
  AutocompleteMenu,
  readTrigger,
  useSuggestions,
  type Suggestion,
  type Trigger,
} from "./Autocomplete.js";
import { Thinking } from "./Thinking.js";
import { MessageActions, MessageEditor } from "./MessageActions.js";
import { MoreIcon } from "./icons.js";
import { useProgress } from "./progress.js";
import { LiveTurn } from "./LiveTurn.js";
import { ToolCall } from "./ToolCall.js";
import { ChatConfig } from "./ChatConfig.js";
import { Markdown } from "./Markdown.js";
import { Modal } from "./Modal.js";
import { hrefFor } from "./routes.js";
import { composerKeyDown, useAutoGrow, useStickToBottom } from "./composer.js";

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Which conversation is mid-send, not whether any is: shared across chats it
  // showed "sending" in every other thread while one was working.
  const [sendingIn, setSendingIn] = useState<string | null>(null);
  const attachments = useAttachments();
  const progress = useProgress();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [archived, setArchived] = useState<Conversation[]>([]);

  // Fetched only when asked for: an archived chat is something you go looking
  // for, and there was no way to reach one at all.
  useEffect(() => {
    if (!showArchived) return;
    void api
      .conversations(true)
      .then((all) => setArchived(all.filter((c) => c.archived)))
      .catch(() => setArchived([]));
  }, [showArchived, conversations]);
  const drop = useDropZone((l) => void attachments.add(l));
  const live = activeId ? progress[activeId] : undefined;
  const running = Boolean(live) || sendingIn === activeId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, draft);

  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [acCursor, setAcCursor] = useState(0);
  const suggestions = useSuggestions(trigger);

  const syncTrigger = (): void => {
    const el = inputRef.current;
    if (!el) return;
    setTrigger(readTrigger(el.value, el.selectionStart ?? el.value.length));
    setAcCursor(0);
  };

  const choose = (s: Suggestion): void => {
    const el = inputRef.current;
    if (!el || !trigger) return;
    const next = applySuggestion(el.value, trigger, s);
    setDraft(next.text);
    setTrigger(null);
    // Restored after React writes the value, or the caret jumps to the end.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };
  const loaded = useRef<string | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId);
  const visible = events;

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
    if (sendingIn === activeId || loaded.current === key) return;
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
  }, [activeId, stamp, sendingIn]);

  // The live turn grows as it streams, so it is part of what pins the scroll.
  useStickToBottom(boxRef, [events, sendingIn, activeId, live?.steps.length, live?.text]);

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
    const target = activeId;
    if ((!text && attachments.files.length === 0) || !target || sendingIn === target) {
      return;
    }
    setSendingIn(target);

    // The message is sent the moment Send is pressed, so it should read that
    // way: the bubble carries its attachments straight away and the composer
    // is empty. Waiting for the turn meant the files sat in the composer,
    // looking unsent, until the answer came back.
    const files = attachments.files;
    setEvents((e) => [
      ...e,
      {
        kind: "message",
        role: "you",
        text,
        ...(files.length
          ? {
              attachments: files.map((f) => ({
                name: f.name,
                ...(f.mediaType.startsWith("image/")
                  ? { src: `data:${f.mediaType};base64,${f.data}` }
                  : {}),
              })),
            }
          : {}),
      },
    ]);
    setDraft("");
    attachments.clear();

    try {
      await api.message(text, target, files);
      // Reload rather than appending the reply: the turn may have made tool
      // calls, and those belong in the transcript too.
      const { events: got } = await api.conversation(target);
      if (target === activeIdRef.current) setEvents(got);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEvents((e) => [...e, { kind: "message", role: "kos", text: `Error: ${msg}` }]);
    } finally {
      setSendingIn((id) => (id === target ? null : id));
    }
  }

  /** Ask the running turn in this conversation to stop. */
  function stop(): void {
    if (!activeId) return;
    void api.stopConversation(activeId).catch(() => undefined);
  }

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [rewinding, setRewinding] = useState(false);

  const rewind = (
    index: number,
    opts: { text?: string; forkTitle?: string } = {},
  ): void => {
    if (!activeId) return;
    setRewinding(true);
    setEditingIndex(null);
    // Cut the thread back now. Waiting for the reply left the old answer on
    // screen while a new one was being written for a question it no longer
    // matched.
    if (opts.forkTitle === undefined) {
      let owner = -1;
      const upTo = events.findIndex((e) => {
        if (e.kind !== "message" || e.role !== "you") return false;
        return ++owner === index;
      });
      if (upTo >= 0) {
        setEvents(
          opts.text === undefined
            ? events.slice(0, upTo + 1)
            : [
                ...events.slice(0, upTo),
                { kind: "message", role: "you", text: opts.text },
              ],
        );
      }
    }
    void api
      .rewind(activeId, index, opts)
      .then((r) => {
        onChanged();
        if (r.conversationId !== activeId) onOpen(r.conversationId);
        else void api.conversation(activeId).then(({ events: got }) => setEvents(got));
      })
      .catch((err: unknown) =>
        setEvents((e) => [
          ...e,
          {
            kind: "message",
            role: "kos",
            text: err instanceof Error ? err.message : String(err),
          },
        ]),
      )
      .finally(() => setRewinding(false));
  };

  const renderEvent = (e: ChatEvent, i: number, turn: number): ReactElement => {
    if (e.kind === "tool") {
      return (
        <ToolCall
          key={i}
          event={e}
          awaitingApproval={
            e.pendingId !== undefined && pendingApprovals.has(e.pendingId)
          }
          onDecide={onDecide}
        />
      );
    }
    if (e.kind === "reasoning") return <Thinking key={i} text={e.text} />;

    if (editingIndex === turn && turn >= 0) {
      return (
        <MessageEditor
          key={i}
          initial={e.text}
          onCancel={() => setEditingIndex(null)}
          onSubmit={(text) => rewind(turn, { text })}
        />
      );
    }

    return (
      <div key={i} className={`turn turn--${e.role}`}>
        {e.text && (
          <div className={`bubble bubble--${e.role}`}>
            <Markdown text={e.text} />
          </div>
        )}
        {/* Outside the bubble, under it: an attachment is a thing that came
            with the message, not part of the sentence. */}
        {e.attachments && e.attachments.length > 0 && (
          <AttachmentStrip items={e.attachments} />
        )}
        {e.text && e.role !== "system" && (
          <MessageActions
            text={e.text}
            busy={rewinding}
            {...(turn >= 0
              ? {
                  onEdit: () => setEditingIndex(turn),
                  onRetry: () => rewind(turn),
                  onFork: () => rewind(turn, { forkTitle: "" }),
                }
              : {})}
          />
        )}
      </div>
    );
  };

  return (
    <div className={`chats ${collapsed ? "is-collapsed" : ""}`}>
      <aside className="chats-list">
        <div className="chats-list-head">
          {/* There was no way to start a chat at all: every conversation had
              to come from the orchestrator deciding to make one. */}
          <button
            type="button"
            className="btn btn--primary chats-new"
            disabled={creating}
            onClick={() => {
              setCreating(true);
              void api
                .newConversation()
                .then((c) => {
                  onChanged();
                  onOpen(c.id);
                })
                .finally(() => setCreating(false));
            }}
          >
            {creating ? "Starting…" : "New chat"}
          </button>
          <input
            className="chats-search"
            value={query}
            placeholder="Search chats…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className={`chats-archived ${showArchived ? "is-on" : ""}`}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "← Back to chats" : "Archived"}
          </button>
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
          {(showArchived ? archived : filtered).map((c) => (
            <li key={c.id}>
              {/* Hover reveals what can be done with a chat, so the list is
                  a list until you need it to be more. */}
              <div className="chats-row">
                <button
                  type="button"
                  className="chats-more"
                  aria-label={`Actions for ${c.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(menuFor === c.id ? null : c.id);
                  }}
                >
                  <MoreIcon />
                </button>
                {menuFor === c.id && (
                  <div className="chats-menu" role="menu">
                    <button
                      type="button"
                      onClick={() => {
                        setMenuFor(null);
                        void api.rewind(c.id, 0, { forkTitle: `${c.title} copy` })
                          .then((r) => {
                            onChanged();
                            onOpen(r.conversationId);
                          })
                          .catch(() => undefined);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuFor(null);
                        void api.archiveConversation(c.id).then(onChanged);
                      }}
                    >
                      {showArchived ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        setMenuFor(null);
                        void api.deleteConversation(c.id).then(onChanged);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
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
                      {progress[c.id]?.step ?? "thinking"}
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
                <h1>
                  {/* In the header rather than floating: positioned against
                      the grid it sat off the left edge of the window and was
                      not the top element at its own centre. */}
                  <button
                    type="button"
                    className="chats-toggle"
                    aria-label={collapsed ? "Show chats" : "Hide chats"}
                    onClick={() => setCollapsed((v) => !v)}
                  >
                    {collapsed ? "›" : "‹"}
                  </button>
                  {active.title}
                </h1>
                {active.brief && <p className="chats-brief">{active.brief}</p>}
                {/* Counts are not something anyone came here to read. Only
                    the tool scope is said, and only when it is not the
                    default, because that is a capability the chat lacks. */}
                {active.toolAllow !== null && (
                  <div className="chats-meta">
                    {active.toolAllow.length === 0
                      ? "no tools"
                      : `scoped to ${active.toolAllow.join(", ")}`}
                  </div>
                )}
              </div>
              <div className="chats-view-actions">
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
              {(() => {
                // Owner turns are numbered in order, because rewind addresses
                // them by position rather than by any id a transcript keeps.
                let owner = -1;
                return visible.map((e, i) => {
                  const turn = e.kind === "message" && e.role === "you" ? ++owner : -1;
                  return renderEvent(e, i, turn);
                });
              })()}
              {live ? (
                <LiveTurn live={live} />
              ) : (
                sendingIn === activeId && (
                  <div className="bubble bubble--kos is-thinking">sending…</div>
                )
              )}
            </div>

            <div
              className={`chats-composer composer ${drop.over ? "is-over" : ""}`}
              {...drop.handlers}
            >
              <AttachmentStrip
                items={attachments.files.map((f) => ({
                  name: f.name,
                  ...(f.mediaType.startsWith("image/")
                    ? { src: `data:${f.mediaType};base64,${f.data}` }
                    : {}),
                }))}
                onRemove={attachments.remove}
              />
              <div className="composer-input">
                <AutocompleteMenu
                  suggestions={suggestions}
                  cursor={acCursor}
                  onPick={choose}
                />
                <HighlightedInput value={draft} textareaRef={inputRef}>
                <textarea
                  className="hl-area"
                  ref={inputRef}
                  rows={1}
                  value={draft}
                  placeholder={`Message ${active.title}…  @ to reference, / for commands`}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    syncTrigger();
                  }}
                  onClick={syncTrigger}
                  onBlur={() => setTrigger(null)}
                  onKeyUp={(e) => {
                    // Arrows move the caret, so the trigger is re-read after
                    // them too, but not while the menu owns them.
                    if (suggestions.length === 0) syncTrigger();
                    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      syncTrigger();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (suggestions.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setAcCursor((c) => (c + 1) % suggestions.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setAcCursor(
                          (c) => (c - 1 + suggestions.length) % suggestions.length,
                        );
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        const picked = suggestions[acCursor];
                        if (picked) {
                          e.preventDefault();
                          choose(picked);
                          return;
                        }
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setTrigger(null);
                        return;
                      }
                    }
                    composerKeyDown(e, () => void send());
                  }}
                />
                </HighlightedInput>
              </div>
              <div className="sheet-composer-bar">
                <AttachButton onAdd={(l) => void attachments.add(l)} />
                <ModelPicker />
                {/* The hint took the widest slot in the row to say something
                    every chat surface already does. The space is the model's. */}
                <span className="composer-spacer" />
                {running ? (
                  <button type="button" className="btn btn--stop" onClick={stop}>
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void send()}
                    disabled={
                      sendingIn === activeId ||
                      (draft.trim() === "" && attachments.files.length === 0)
                    }
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
