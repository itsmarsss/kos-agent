import { useEffect, useState, type ReactElement } from "react";

import { api, type Conversation, type ToolInfo } from "./api.js";

/**
 * Owner-editable configuration for one conversation: what it is called, what
 * it is for, and what it may reach.
 *
 * The tool scope lives here rather than being decided when the conversation is
 * created, because a restriction guessed at up front becomes a capability the
 * conversation silently lacks weeks later. Empty means the full toolkit.
 */

export interface ChatConfigProps {
  conversation: Conversation;
  onSaved: () => void;
  onClose: () => void;
}

/** Group tools by their prefix; the scope is expressed in those terms. */
function familiesOf(tools: ToolInfo[]): string[] {
  const seen = new Set<string>();
  for (const t of tools) seen.add(t.name.split(".")[0] ?? t.name);
  return [...seen].sort();
}

export function ChatConfig({
  conversation,
  onSaved,
  onClose,
}: ChatConfigProps): ReactElement {
  const [title, setTitle] = useState(conversation.title);
  const [brief, setBrief] = useState(conversation.brief ?? "");
  const [allow, setAllow] = useState<string[] | null>(conversation.toolAllow);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.tools().then(setTools).catch(() => setTools([]));
  }, []);

  const families = familiesOf(tools);
  const unrestricted = allow === null;

  /** First click on an unrestricted chat starts a scope containing just that. */
  function toggle(family: string): void {
    setAllow((cur) => {
      if (cur === null) return [family];
      return cur.includes(family)
        ? cur.filter((f) => f !== family)
        : [...cur, family];
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      if (title.trim() && title !== conversation.title) {
        await api.renameConversation(conversation.id, title.trim());
      }
      await api.configureConversation(conversation.id, {
        brief: brief.trim() === "" ? null : brief,
        toolAllow: allow,
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="chatcfg">
      <label className="chatcfg-field">
        <span className="chatcfg-label">Title</span>
        <input
          className="chats-search"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label className="chatcfg-field">
        <span className="chatcfg-label">Brief</span>
        <textarea
          className="chatcfg-textarea"
          rows={4}
          value={brief}
          placeholder="What is this conversation for, and how should it behave?"
          onChange={(e) => setBrief(e.target.value)}
        />
        <span className="hint">Added to the system prompt for this chat only.</span>
      </label>

      <div className="chatcfg-field">
        <span className="chatcfg-label">Tools</span>
        <div className="chatcfg-tools">
          {families.map((f) => {
            const on = unrestricted || allow.includes(f);
            return (
              <button
                key={f}
                type="button"
                className={`chip ${on ? "is-on" : ""}`}
                onClick={() => toggle(f)}
                title={
                  unrestricted
                    ? "Currently unrestricted; selecting one starts a scope"
                    : on
                      ? "Allowed"
                      : "Withheld"
                }
              >
                {f}
              </button>
            );
          })}
        </div>
        <span className="hint">
          {unrestricted
            ? "Unrestricted: this chat has the full toolkit."
            : allow.length === 0
              ? "No tools at all. This chat can talk, and nothing else."
              : `Only these are available. ${families.length - allow.length} withheld.`}
        </span>
        <div className="chatcfg-presets">
          {!unrestricted && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setAllow(null)}
            >
              Full toolkit
            </button>
          )}
          {(unrestricted || allow.length > 0) && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setAllow([])}
            >
              No tools
            </button>
          )}
        </div>
      </div>

      <div className="chatcfg-bar">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
