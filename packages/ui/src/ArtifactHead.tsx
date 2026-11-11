import { ChevronLeft, ChevronRight, IconButton, MoreIcon, Tag, arrive, ease, useDismiss } from "@kos/kit";
import { relativeWords } from "@kos/shared";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";

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
  /** The owner's own handles on it (rename, duplicate, move, the trash), last in the menu. */
  manage?: MenuItem[];
  /** Show it full screen: a deck presents. */
  onPresent?: () => void;
  /** Present a deck with its notes: the presenter view here, the slide in an audience window. */
  onPresentNotes?: () => void;
  edit?: EditState;
  onEdit: (action: EditTold["action"]) => void;
  deck?: DeckView;
  onDeck: (action: DeckPress) => void;
  ref?: Ref<HTMLElement>;
}

/** A row of an artifact's menu; `narrow` ones are on the viewer's row itself when there is room. */
export interface MenuItem {
  label: string;
  act: () => void;
  narrow?: boolean;
  pressed?: boolean;
  /** A line above it: the start of another group. */
  divided?: boolean;
  danger?: boolean;
  /** What cannot be undone asks once, beside the item (ConfirmButton), with these words. */
  confirm?: string;
  /** Only where a presenter sits at a screen and keyboard: away on a narrow view and on a touch screen. */
  desk?: boolean;
}

export function ArtifactHead(props: ArtifactHeadProps): ReactElement {
  const { record, edit, deck } = props;
  const editing = edit?.editing === true;
  const canEdit = edit !== undefined;
  const steering = deck !== undefined && !deck.reading;
  const status = edit ? edit.status || (editing ? (edit.pending ? "Editing" : "Editing, all saved") : "") : "";
  // In the trash it is only looked at: no versions to restore, nothing to ask.
  const trashed = record.trashedAt !== undefined;

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
    if (props.onPresentNotes) items.push({ label: "Present with notes", act: props.onPresentNotes, desk: true });
    if (!trashed) items.push({ label: "History", act: props.onHistory, narrow: true });
    // A doc's Edit is the owner's own hand; asking KOS is the second way, so it waits in the menu.
    if (props.onAsk) items.push({ label: "Edit with KOS", act: props.onAsk, narrow: !canEdit });
  }
  if (props.onOpenOwner) items.push({ label: `Open ${props.ownerName}`, act: props.onOpenOwner });
  if (!editing && props.manage?.length) items.push(...props.manage.map((item, i) => (i === 0 && items.length ? { ...item, divided: true } : item)));

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
            {!trashed && (
              <button type="button" className="btn btn--ghost btn--sm artifact-view-wide" aria-expanded={props.history} onClick={props.onHistory}>
                History
              </button>
            )}
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
          </>
        )}
        <ArtifactMenu about={record.description} items={items} />
      </div>
    </header>
  );
}

/**
 * An artifact's menu: what it is about, then what can be done with it. The
 * viewer's row puts there what it has no room for; a gallery card, its
 * management. Fixed to the window, so no card or list clips it.
 */
export function ArtifactMenu({ about, items, label = "More", className }: { about?: string; items: MenuItem[]; label?: string; className?: string }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const aboutId = useId();
  // Escape closes it here and gives the focus back to its button.
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useDismiss(open, () => close(false), { inside: [wrap], escape: false });
  // The focus moves into it as it opens, onto the first item the row has no room for.
  useEffect(() => {
    if (open) visible()[0]?.focus();
  }, [open]);
  if (!about && !items.length) return null;
  const visible = (): HTMLElement[] => [...(list.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])].filter((el) => getComputedStyle(el).display !== "none");
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = visible();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number): void => {
      e.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") close(false);
  };
  const toggle = (): void => {
    const r = button.current?.getBoundingClientRect();
    if (r) setPlace({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((v) => !v);
  };
  // Only the narrow ones: the menu has nothing more to say wider when it holds no description and nothing else.
  const wideEmpty = !about && items.every((i) => i.narrow);
  return (
    <div className={`artifact-view-menu-wrap${wideEmpty ? " artifact-view-narrow" : ""}${className ? ` ${className}` : ""}`} ref={wrap}>
      <IconButton ref={button} className="artifact-view-more" label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <MoreIcon title="" />
      </IconButton>
      <AnimatePresence>
        {open && (
          <m.div className="chats-menu artifact-view-menu" style={place} variants={arrive} initial="hidden" animate="show" exit="hidden" transition={ease} onKeyDown={keys}>
            {about && (
              <p className="artifact-view-about" id={aboutId}>
                {about}
              </p>
            )}
            <div role="menu" aria-label={label} ref={list} {...(about ? { "aria-describedby": aboutId } : {})}>
              {items.map((item) => {
                const cls = [item.narrow && "artifact-view-narrow", item.desk && "artifact-view-desk", item.divided && "is-divided", item.danger && "is-danger"].filter(Boolean).join(" ") || undefined;
                const act = (): void => {
                  close(false);
                  item.act();
                };
                return item.confirm ? (
                  <ConfirmButton key={item.label} role="menuitem" className={cls ?? ""} label={item.label} text={item.confirm} onConfirm={act} />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    tabIndex={-1}
                    role={item.pressed === undefined ? "menuitem" : "menuitemcheckbox"}
                    {...(item.pressed === undefined ? {} : { "aria-checked": item.pressed })}
                    className={cls}
                    onClick={act}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
