import { useEffect, useState, type ReactElement } from "react";

import { api, type Conversation, type Project } from "./api.js";
import { Select } from "./Select.js";

/**
 * Handing a chat on by hand.
 *
 * Pick where it goes, read the brief KOS drafted from the thread, change
 * what you like, say what the other chat should do with it, send. The
 * target gets it as a message that says where it came from and that you
 * asked; it runs with an ask as work, and without one keeps it for later.
 */
export function HandoffForm({
  from,
  projects,
  conversations,
  onDone,
  onClose,
}: {
  from: { id: string; title: string };
  projects: Project[];
  conversations: Conversation[];
  onDone: (target: { conversationId: string; title: string }) => void;
  onClose: () => void;
}): ReactElement {
  const [to, setTo] = useState("");
  const [brief, setBrief] = useState("");
  const [drafting, setDrafting] = useState(true);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .draftHandoff(from.id)
      .then((r) => {
        if (!cancelled) setBrief(r.brief);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not draft a brief: ${err instanceof Error ? err.message : String(err)}. Write one below.`);
      })
      .finally(() => {
        if (!cancelled) setDrafting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from.id]);

  const targets = [
    ...projects.map((p) => ({ value: `@project:${p.slug}`, label: p.name, hint: "project" })),
    ...conversations
      .filter((c) => c.id !== from.id && !c.archived && !c.id.startsWith("project:"))
      .map((c) => ({ value: `@chat:[${c.id}]`, label: c.title, hint: "chat" })),
  ];

  const send = (): void => {
    if (!to || !brief.trim() || busy) return;
    setBusy(true);
    setError(null);
    void api
      .handoffConversation({ from: from.id, to, brief: brief.trim(), ...(ask.trim() ? { ask: ask.trim() } : {}) })
      .then((r) => onDone({ conversationId: r.conversationId, title: r.title }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="handoff-form"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label className="kos-field">
        <span className="kos-field-label">To</span>
        <Select className="settings-select" label="Where it goes" value={to} options={[{ value: "", label: "pick a chat or project" }, ...targets]} onChange={setTo} />
      </label>
      <label className="kos-field">
        <span className="kos-field-label">The brief</span>
        <textarea
          className="kos-input"
          rows={9}
          value={brief}
          placeholder={drafting ? "Drafting from this chat…" : "What the other chat needs to know, in a few lines."}
          disabled={drafting}
          onChange={(e) => setBrief(e.target.value)}
        />
        <span className="hint">Drafted by KOS from this thread; change anything. It goes over as a message from this chat, at your request.</span>
      </label>
      <label className="kos-field">
        <span className="kos-field-label">What it should do with it</span>
        <input className="kos-input" value={ask} placeholder="Leave empty to have it kept for later" onChange={(e) => setAsk(e.target.value)} />
      </label>
      {error && <p className="ops-alert ops-alert--err">{error}</p>}
      <div className="rename-actions">
        <button type="submit" className="btn btn--primary" disabled={busy || drafting || !to || !brief.trim()}>
          {busy ? "Handing off…" : "Hand off"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
