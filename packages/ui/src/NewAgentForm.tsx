import { useState, type FormEvent, type ReactElement } from "react";

import { api } from "./api.js";

/**
 * The form for an agent the owner starts by hand inside a project: a name,
 * and optionally what it is and what to do first. Before this only the
 * orchestrator could start one.
 */
export function NewAgentForm({
  slug,
  onMade,
  onCancel,
  onError,
}: {
  slug: string;
  onMade: (id: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const made = await api.createProjectAgent(slug, {
        title: title.trim(),
        ...(brief.trim() ? { brief: brief.trim() } : {}),
        ...(task.trim() ? { task: task.trim() } : {}),
      });
      onMade(made.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="agent-form" onSubmit={(e) => void submit(e)}>
      <input
        className="chats-search"
        autoFocus
        placeholder="Agent name, e.g. Receipts"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="ops-textarea"
        rows={2}
        placeholder="Brief (optional): standing instructions for this agent"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <textarea
        className="ops-textarea"
        rows={2}
        placeholder="First task (optional): asked as soon as it starts"
        value={task}
        onChange={(e) => setTask(e.target.value)}
      />
      <div className="agent-form-row">
        <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={!title.trim() || submitting}>
          {submitting ? "Starting…" : "Start agent"}
        </button>
      </div>
    </form>
  );
}
