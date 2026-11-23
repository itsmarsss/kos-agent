import { useState, type ReactElement } from "react";

import { checkName, kindWord, NAME_MAX } from "@kos/shared";
import { Field, SheetFoot } from "@kos/kit";

import { fieldErrorOf } from "./api.js";
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

const FORM_ID = "new-project-form";

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; type: string }) => Promise<void>;
  /** The projects' names, so a taken one is said as it is typed rather than on Create. */
  taken?: readonly string[];
}

export function NewProjectDialog({ open, onClose, onCreate, taken = [] }: NewProjectDialogProps): ReactElement {
  const [draft, setDraft] = useState({ name: "", kind: "project", other: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the server said about the name, until the name changes.
  const [refused, setRefused] = useState<string | null>(null);
  // An empty name is said only once Create was tried: a fresh form is not an error.
  const [tried, setTried] = useState(false);
  const check = checkName(draft.name, { noun: "project", taken });
  const nameError = refused ?? (check && (check.problem !== "empty" || tried) ? check.message : null);
  const create = (): void => {
    setTried(true);
    const name = draft.name.trim();
    const type = (draft.kind === "other" ? draft.other : draft.kind).trim() || "project";
    if (check || creating) return;
    setCreating(true);
    setError(null);
    void onCreate({ name, type })
      .then(() => {
        onClose();
        setDraft({ name: "", kind: "project", other: "" });
        setTried(false);
      })
      .catch((err: unknown) => {
        const onName = fieldErrorOf(err, "name");
        if (onName) setRefused(onName);
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setCreating(false));
  };
  return (
    <Drawer
      open={open}
      title="New project"
      subtitle="A name and a kind; empty until you or KOS put something in it"
      onClose={onClose}
      footer={
        <SheetFoot
          onCancel={onClose}
          {...(!creating && (check !== null || refused !== null) ? { held: draft.name.trim() ? "Fix the name first." : "Give it a name first." } : {})}
          primary={
            <button type="submit" form={FORM_ID} className="btn btn--primary" disabled={creating || check !== null || refused !== null}>
              {creating ? "Creating…" : "Create"}
            </button>
          }
        />
      }
    >
      <form
        id={FORM_ID}
        className="rename-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Field label="Name" required {...(nameError ? { error: nameError } : {})} {...(draft.name.trim().length > NAME_MAX * 0.8 ? { meta: <span className="hint">{draft.name.trim().length} of {NAME_MAX} characters</span> } : {})}>
          <input
            className="kos-input"
            autoFocus
            value={draft.name}
            placeholder="Reading log"
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => {
              setRefused(null);
              setDraft({ ...draft, name: e.target.value });
            }}
          />
        </Field>
        <Field label="Kind" hint="Empty to begin with: a chat of its own, and nothing else until you or KOS put something there.">
          <Select
            className="settings-select"
            label="Kind"
            value={draft.kind}
            options={[...KINDS.map((k) => ({ value: k, label: kindWord(k) })), { value: "other", label: "Something else…" }]}
            onChange={(kind) => setDraft({ ...draft, kind })}
          />
          {draft.kind === "other" && <input className="kos-input" value={draft.other} placeholder="a word for what it is" onChange={(e) => setDraft({ ...draft, other: e.target.value })} />}
        </Field>
        {error && <p className="ops-alert ops-alert--err">{error}</p>}
      </form>
    </Drawer>
  );
}
