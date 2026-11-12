import { Face, Field, NavIcon } from "@kos/kit";
import type { ArtifactKind } from "@kos/shared";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { api, type Project } from "./api.js";
import { chatIdOf, KIND_WORD, type ArtifactOwner } from "./ArtifactsPage.js";
import { Modal } from "./Modal.js";
import { ProjectMark } from "./ProjectMark.js";
import { Select, type SelectOption } from "./Select.js";

/**
 * New artifact: what kind it is, who owns it, and a sentence for KOS. The
 * request goes to the owner's own chat (the project's, the blob's thread, or
 * KOS at the root for the workspace), as Edit with KOS does, and the owner is
 * taken there to watch it being made.
 */

/** The kinds, in the order the owner most often asks for them, each with what it is for and a sentence to start from. */
const KINDS: readonly { kind: ArtifactKind; about: string; example: string }[] = [
  { kind: "doc", about: "A report, plan, memo or guide", example: "A one-page plan for the spring garden, with what it costs" },
  { kind: "deck", about: "Slides to present, 16:9", example: "Ten slides on how the quarter went, for Monday's review" },
  { kind: "sheet", about: "A spreadsheet with totals and charts", example: "A monthly budget with totals by category" },
  { kind: "page", about: "An app, dashboard or tool", example: "A habit tracker I can tick off each day" },
];

/** The owner picker's value for the workspace; a project is its slug, a blob `blob:<name>`. */
const WORKSPACE = "@workspace";
const BLOB = "blob:";

/**
 * How long the dialog waits on the send before handing over. The answer to a
 * message comes when its turn ends, minutes away; a request that is refused
 * or cannot be sent fails at once, and that is the failure the dialog keeps
 * the owner's words for. Past this the turn is running, and its chat, where
 * the owner is taken, shows it as it goes, a late failure included.
 */
export const HANDOFF_MS = 1500;

const ownerOfValue = (value: string): ArtifactOwner => (value === WORKSPACE ? null : value.startsWith(BLOB) ? { blob: value.slice(BLOB.length) } : { project: value });

/** What the owner's chat is asked: the owner's words, then the kind, where it goes, and how to finish. */
export function newRequest(kind: ArtifactKind, words: string, owner: ArtifactOwner): string {
  const word = KIND_WORD[kind].toLowerCase();
  const where = !owner ? ", leaving project out so it is a workspace artifact" : "project" in owner ? ` for @project:${owner.project}` : ", leaving project out so it is your own";
  return `${words.trim()}\n\nWrite it as a ${word}: read artifacts.guide for a ${word}, write it with artifacts.write${where}, and check it once with artifacts.check.`;
}

export interface NewArtifactProps {
  open: boolean;
  projects: Project[];
  onClose: () => void;
  /** The request was sent: go to the chat that is making it. */
  onAsked: (owner: ArtifactOwner) => void;
}

export function NewArtifactDialog({ open, projects, onClose, onAsked }: NewArtifactProps): ReactElement {
  const [kind, setKind] = useState<ArtifactKind>("doc");
  const [owner, setOwner] = useState(WORKSPACE);
  const [words, setWords] = useState("");
  const [blobs, setBlobs] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const tiles = useRef<HTMLDivElement>(null);

  // The living blobs, read as it opens: one made since the page loaded is offered too.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void api
      .agents()
      .then((got) => !stale && setBlobs(got.agents.map((a) => a.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [open]);

  const owners: SelectOption[] = [
    { value: WORKSPACE, label: "Workspace", icon: <NavIcon name="files" /> },
    // Not Maintenance (a system project): it is where KOS repairs itself, not a place for the owner's work.
    ...projects
      .filter((p) => p.type !== "system")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.slug, label: p.name, icon: <ProjectMark slug={p.slug} name={p.name} colour={p.colour} /> })),
    ...blobs.map((name) => ({ value: `${BLOB}${name}`, label: name, icon: <Face seed={name} size={14} /> })),
  ];
  // One no longer offered (a blob removed, a project gone since) goes back to the workspace, rather than sending to nowhere.
  const offered = owners.map((o) => o.value).join("\n");
  useEffect(() => {
    if (!offered.split("\n").includes(owner)) setOwner(WORKSPACE);
  }, [offered, owner]);
  const ownerName = owners.find((o) => o.value === owner)?.label ?? "Workspace";
  const chosen = KINDS.find((k) => k.kind === kind)!;

  const close = (): void => {
    if (sending) return;
    setWords("");
    setError(undefined);
    onClose();
  };
  const ask = async (): Promise<void> => {
    if (!words.trim() || sending) return;
    const whose = ownerOfValue(owner);
    setSending(true);
    setError(undefined);
    const send = api.message(newRequest(kind, words, whose), chatIdOf(whose));
    try {
      await Promise.race([send, new Promise((r) => setTimeout(r, HANDOFF_MS))]);
    } catch (err) {
      setSending(false);
      setError(`Could not ask KOS: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // A failure after the handover is the chat's to show, not an unhandled one here.
    send.catch(() => undefined);
    setSending(false);
    setWords("");
    onClose();
    onAsked(whose);
  };

  // One stop on the tab key; the arrows walk the kinds and choose as they go, as a radio group does.
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = KINDS.findIndex((k) => k.kind === kind);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = KINDS[(at + step + KINDS.length) % KINDS.length]!;
    setKind(next.kind);
    tiles.current?.querySelector<HTMLElement>(`[data-kind="${next.kind}"]`)?.focus();
  };

  return (
    <Modal open={open} title="New artifact" onClose={close}>
      <form
        className="artifact-dialog new-artifact"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <Field label="Kind" group>
          <div className="new-artifact-kinds" role="radiogroup" aria-label="Kind" ref={tiles} onKeyDown={keys}>
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                data-kind={k.kind}
                aria-checked={k.kind === kind}
                tabIndex={k.kind === kind ? 0 : -1}
                className={`new-artifact-kind${k.kind === kind ? " is-on" : ""}`}
                onClick={() => setKind(k.kind)}
              >
                <span className="tile" aria-hidden="true">
                  <NavIcon name={k.kind} />
                </span>
                <span className="new-artifact-kind-name">{KIND_WORD[k.kind]}</span>
                <span className="new-artifact-kind-about">{k.about}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Owner">
          <Select className="new-artifact-owner" label="Owner" value={owner} options={owners} onChange={setOwner} />
        </Field>
        <Field label="What should it be?">
          <textarea
            className="kos-input"
            rows={3}
            autoFocus
            value={words}
            placeholder={chosen.example}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void ask();
              }
            }}
          />
        </Field>
        {error && (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        )}
        <div className="artifact-dialog-actions">
          <span className="artifact-dialog-note">Goes to {owner === WORKSPACE ? "KOS" : `${ownerName}'s chat`}</span>
          <button type="button" className="btn btn--ghost" disabled={sending} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!words.trim() || sending} aria-busy={sending || undefined}>
            {sending ? "Asking…" : "Ask KOS"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
