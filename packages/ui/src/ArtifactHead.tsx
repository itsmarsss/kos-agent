import { ChevronLeft, ChevronRight, IconButton, MoreIcon, Tag, arrive, ease, useDismiss } from "@kos/kit";
import { relativeWords } from "@kos/shared";
import { AnimatePresence, m } from "motion/react";
import { useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type Ref } from "react";

import type { PageSummary } from "./api.js";
import { ConfirmButton } from "./kit.js";
import type { DeckPress, DeckView, EditState } from "./widgets/ArtifactPage.js";
import type { EditTold } from "./widgets/frameheight.js";

/**
 * The artifact viewer's head: one compact row that sticks over the artifact
 * as it scrolls by. Where it is (back, its owner, its title), what it is
 * (kind, when it changed), then what can be done with it. The artifact keeps
 * its own title, kicker and lede, so the head says them once, small.
 *
 * The frame's own controls live here too, posted up through the frame's
 * bridge: a doc's Edit, Undo, Redo, Discard and Done with how the save
 * stands, and a deck's slide, notes and grid. So there is one toolbar, not
 * one over another, and one Present. On a phone the row keeps one line: the
 * title, Done while editing, and the rest in the overflow menu.
 */

export interface ArtifactHeadProps {
  record: PageSummary;
  /** The owner's mark and name, drawn by the caller (OwnerMark). */
  owner: ReactNode;
  ownerName: string;
  /** The kind as a word, or what an older widget page is. */
  kind: string;
  /** Where back goes, as a place: "Artifacts", "Home", "the chat". */
  backTo: string;
  onBack: () => void;
  /** Go to the owner's own page; absent when there is none to go to. */
  onOpenOwner?: () => void;
  onHistory: () => void;
  history: boolean;
  /** Ask KOS for a change; absent where KOS no longer changes it (a removed blob's, an older widget page). */
  onAsk?: () => void;
  asking: boolean;
  /** Delete what a removed blob made. */
  onDelete?: () => void;
  /** Show it full screen: a deck presents. */
  onPresent?: () => void;
  edit?: EditState;
  onEdit: (action: EditTold["action"]) => void;
  deck?: DeckView;
  onDeck: (action: DeckPress) => void;
  ref?: Ref<HTMLElement>;
}

/** A row of the overflow menu; `narrow` ones are on the row itself when there is room. */
interface MenuItem {
  label: string;
  act: () => void;
  narrow?: boolean;
  pressed?: boolean;
}

export function ArtifactHead(props: ArtifactHeadProps): ReactElement {
  const { record, edit, deck } = props;
  const editing = edit?.editing === true;
  const canEdit = edit !== undefined;
  const steering = deck !== undefined && !deck.reading;
  const status = edit ? edit.status || (editing ? (edit.pending ? "Editing" : "Editing, all saved") : "") : "";

  // What the menu holds: on a phone everything but Done, wider only what the row has no room for.
  const items: MenuItem[] = [];
  if (editing) {
    items.push({ label: "Undo", act: () => props.onEdit("undo"), narrow: true }, { label: "Redo", act: () => props.onEdit("redo"), narrow: true }, { label: "Discard changes", act: () => props.onEdit("discard"), narrow: true });
    // While editing the row holds the editing; the rest waits here.
    items.push({ label: "History", act: props.onHistory });
  } else {
    if (canEdit) items.push({ label: "Edit", act: () => props.onEdit("edit"), narrow: true });
    if (steering) items.push({ label: "Notes", act: () => props.onDeck("notes"), narrow: true, pressed: deck.notes }, { label: "All slides", act: () => props.onDeck("grid"), narrow: true, pressed: deck.grid });
    if (props.onPresent) items.push({ label: "Present", act: props.onPresent, narrow: true });
    items.push({ label: "History", act: props.onHistory, narrow: true });
    // A doc's Edit is the owner's own hand; asking KOS is the second way, so it waits in the menu.
    if (props.onAsk) items.push({ label: "Edit with KOS", act: props.onAsk, narrow: !canEdit });
  }
  if (props.onOpenOwner) items.push({ label: `Open ${props.ownerName}`, act: props.onOpenOwner });

  return (
    <header className={`artifact-view-head${editing ? " is-editing" : ""}`} ref={props.ref}>
      <IconButton className="artifact-view-back" label={`Back to ${props.backTo}`} onClick={props.onBack}>
        <ChevronLeft size={15} title="" />
      </IconButton>
      <div className="artifact-view-crumbs">
        {props.onOpenOwner ? (
          <button type="button" className="artifact-view-owner" aria-label={`Open ${props.ownerName}`} title={`Open ${props.ownerName}`} onClick={props.onOpenOwner}>
            {props.owner}
          </button>
        ) : (
          <span className="artifact-view-owner">{props.owner}</span>
        )}
        <span className="artifact-view-sep" aria-hidden="true">
          <ChevronRight size={12} title="" />
        </span>
        <h1 className="artifact-view-title">{record.title}</h1>
        <span className="artifact-view-meta">
          <Tag>{props.kind}</Tag>
          <span className="artifact-view-time">{relativeWords(Math.round(record.updatedAt / 1000))}</span>
        </span>
      </div>
      <div className="artifact-view-acts">
        {status && (
          <span className={`artifact-view-status${edit?.bad ? " is-bad" : ""}`} role="status" aria-live="polite">
            {status}
          </span>
        )}
        {steering && (
          <span className="artifact-view-deck" role="group" aria-label="Slides">
            <IconButton label="Previous slide" disabled={deck.index === 0} onClick={() => props.onDeck("prev")}>
              <ChevronLeft size={14} title="" />
            </IconButton>
            <span className="artifact-view-count" aria-live="polite">
              {Math.min(deck.index + 1, deck.count)} / {deck.count}
            </span>
            <IconButton label="Next slide" disabled={deck.index >= deck.count - 1} onClick={() => props.onDeck("next")}>
              <ChevronRight size={14} title="" />
            </IconButton>
          </span>
        )}
        {steering && (
          <>
            <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" aria-pressed={deck.notes} onClick={() => props.onDeck("notes")}>
              Notes
            </button>
            <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" aria-pressed={deck.grid} onClick={() => props.onDeck("grid")}>
              Grid
            </button>
          </>
        )}
        {editing ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" title="Undo (Cmd+Z)" onClick={() => props.onEdit("undo")}>
              Undo
            </button>
            <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" title="Redo (Shift+Cmd+Z)" onClick={() => props.onEdit("redo")}>
              Redo
            </button>
            <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" title="Put back what is not yet saved, and stop editing" onClick={() => props.onEdit("discard")}>
              Discard
            </button>
            <button type="button" className="btn btn--primary btn--sm" title="Save and stop editing (Cmd+S)" onClick={() => props.onEdit("done")}>
              Done
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" aria-expanded={props.history} onClick={props.onHistory}>
              History
            </button>
            {canEdit && (
              <button type="button" className="btn btn--sm artifact-view-wide" title="Edit the text in place" onClick={() => props.onEdit("edit")}>
                Edit
              </button>
            )}
            {!canEdit && props.onAsk && (
              <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" aria-expanded={props.asking} onClick={props.onAsk}>
                Edit with KOS
              </button>
            )}
            {props.onPresent && (
              <button type="button" className="btn btn--sm artifact-view-wide" title="Present full screen (P)" onClick={props.onPresent}>
                Present
              </button>
            )}
            {props.onDelete && (
              <ConfirmButton label="Delete" text={`Delete “${record.title}”, which the removed blob ${record.blob} made, and its versions?`} onConfirm={props.onDelete} />
            )}
          </>
        )}
        <ViewerMenu about={record.description} items={items} />
      </div>
    </header>
  );
}

/** The overflow menu: what the artifact is about, then what the row has no room for. */
function ViewerMenu({ about, items }: { about?: string; items: MenuItem[] }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), { inside: [wrap] });
  if (!about && !items.length) return null;
  const toggle = (button: HTMLElement): void => {
    const r = button.getBoundingClientRect();
    setPlace({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((v) => !v);
  };
  // Only the narrow ones: the menu has nothing more to say wider when it holds no description and nothing else.
  const wideEmpty = !about && items.every((i) => i.narrow);
  return (
    <div className={`artifact-view-menu-wrap${wideEmpty ? " artifact-view-narrow" : ""}`} ref={wrap}>
      <IconButton className="artifact-view-more" label="More" aria-haspopup="menu" aria-expanded={open} onClick={(e) => toggle(e.currentTarget)}>
        <MoreIcon title="" />
      </IconButton>
      <AnimatePresence>
        {open && (
          <m.div className="chats-menu artifact-view-menu" role="menu" style={place} variants={arrive} initial="hidden" animate="show" exit="hidden" transition={ease}>
            {about && <p className="artifact-view-about">{about}</p>}
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role={item.pressed === undefined ? "menuitem" : "menuitemcheckbox"}
                {...(item.pressed === undefined ? {} : { "aria-checked": item.pressed })}
                className={item.narrow ? "artifact-view-narrow" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.act();
                }}
              >
                {item.label}
              </button>
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
