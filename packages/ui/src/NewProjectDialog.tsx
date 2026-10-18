import { useState, type ReactElement } from "react";

import { Field } from "./kit.js";
import { Drawer } from "./Drawer.js";
import { Select } from "./Select.js";

/**
 * New project: a name, a kind, and nothing else to decide, in a drawer so
 * the page stays beside it.
 *
 * One form for both places a project can be made from, the Projects page
 * and the Chats rail, so the two ask the same two questions and make the
 * same empty thing: a chat of its own, with nothing in it until the owner
 * or KOS puts something there.
 */

/** The kinds a project usually is; anything else can be typed. */
const KINDS = ["project", "tracker", "notes", "budget", "app", "research"];

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; type: string }) => Promise<void>;
}

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps): ReactElement {
  const [draft, setDraft] = useState({ name: "", kind: "project", other: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = (): void => {
    const name = draft.name.trim();
    const type = (draft.kind === "other" ? draft.other : draft.kind).trim() || "project";
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    void onCreate({ name, type })
      .then(() => {
        onClose();
        setDraft({ name: "", kind: "project", other: "" });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false));
  };
  return (
    <Drawer open={open} title="New project" subtitle="A name and a kind; empty until you or KOS put something in it" onClose={onClose}>
      <form
        className="rename-form"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Field label="Name" required>
          <input className="kos-input" autoFocus value={draft.name} placeholder="Reading log" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Kind" hint="Empty to begin with: a chat of its own, and nothing else until you or KOS put something there.">
          <Select
            className="settings-select"
            label="Kind"
            value={draft.kind}
            options={[...KINDS.map((k) => ({ value: k, label: k })), { value: "other", label: "something else…" }]}
            onChange={(kind) => setDraft({ ...draft, kind })}
          />
          {draft.kind === "other" && <input className="kos-input" value={draft.other} placeholder="a word for what it is" onChange={(e) => setDraft({ ...draft, other: e.target.value })} />}
        </Field>
        {error && <p className="ops-alert ops-alert--err">{error}</p>}
        <div className="rename-actions">
          <button type="submit" className="btn btn--primary" disabled={creating || !draft.name.trim()}>
            {creating ? "Creating…" : "Create"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
