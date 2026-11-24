import { memo, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";

import { clockWords } from "@kos/shared";
import { type BlockActions, Fold, type FoldRule, MessageTime, QuoteLine, Timed } from "@kos/kit";

import type { ChatEvent } from "./api.js";
import { AttachmentStrip } from "./AttachmentStrip.js";
import { ChatWords } from "./ChatWords.js";
import { MentionedFiles } from "./MentionedFiles.js";
import { MessageActions } from "./MessageActions.js";
import { OriginLine } from "./OriginLine.js";

/** What the owner can do to one of their own turns. */
export type TurnAction = "edit" | "retry" | "fork";

const SAID: Record<"you" | "kos" | "system", { said: string; thing: string }> = {
  you: { said: "You said", thing: "your message" },
  kos: { said: "KOS said", thing: "KOS's reply" },
  system: { said: "Note", thing: "the note" },
};

/**
 * Who said a message and when, as a screen reader hears it ("KOS said,
 * 6:52 PM"), and what its buttons act on ("KOS's reply, 6:52 PM"), so a
 * list of buttons is not a column of Copy, Copy, Copy.
 */
export function turnWords(role: "you" | "kos" | "system", at?: number, text = ""): { label: string; of: string } {
  const when = at ? `, ${clockWords(at)}` : "";
  const start = excerpt(text);
  return { label: `${SAID[role].said}${when}`, of: `${SAID[role].thing}${start ? ` “${start}”` : ""}${when}` };
}

/** A message's first words, plain, for telling its buttons from the next message's said in the same minute. */
export function excerpt(text: string, most = 32): string {
  const plain = text.replace(/[`*_#>[\]()]/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= most) return plain;
  const cut = plain.slice(0, most);
  return `${cut.slice(0, cut.lastIndexOf(" ") > most / 2 ? cut.lastIndexOf(" ") : most)}…`;
}

/** A message sent before ones above it, answered after them: its turn waited (on an approval, say) while they went through. */
export function answeredLate(at: number | undefined, before: number | undefined): boolean {
  return at !== undefined && before !== undefined && at < before;
}

/**
 * When the owner's own message folds (kit `Fold`). At a desk a bubble line
 * holds about 90 characters, so 800 characters is some nine lines and the
 * fold shows eight; a phone's line holds about 35, so its line count comes
 * first. KOS's replies never fold.
 */
export const OWNER_FOLD: Readonly<Record<"desk" | "phone", FoldRule>> = {
  desk: { lines: 8, pastLines: 12, pastChars: 800 },
  phone: { lines: 6, pastLines: 9, pastChars: 600 },
};
const PHONE = "(max-width: 640px)";

function phoneWidth(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;
}
function onWidth(change: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", change);
  return () => mq.removeEventListener("change", change);
}

/** The owner's long messages opened in this page, kept while it is open so a message drawn again stays open. */
const opened = new Set<string>();

/** The owner's words, folded when long; opened by a search that found them, or by the owner, and kept open. */
function OwnerWords({ text, at, found, children }: { text: string; at?: number; found: boolean; children: ReactElement }): ReactElement {
  const rule = OWNER_FOLD[useSyncExternalStore(onWidth, phoneWidth, () => false) ? "phone" : "desk"];
  const key = `${at ?? ""}:${text}`;
  const [open, setOpen] = useState(() => found || opened.has(key));
  // A search opens it where it found it, as the owner's own press would, and it can be folded again.
  useEffect(() => {
    if (found) setOpen(true);
  }, [found]);
  return (
    <Fold
      rule={rule}
      chars={text.length}
      what="your message"
      open={open}
      onOpen={(next) => {
        if (next) opened.add(key);
        else opened.delete(key);
        setOpen(next);
      }}
    >
      {children}
    </Fold>
  );
}

/**
 * One message in the thread: the owner's bubble, KOS's words or a note,
 * where it came from, what came with it, and what can be done with it. Its
 * time shows on hover, focus or a tap: the owner's left of their bubble, a
 * note's after it, KOS's at the end of its actions row.
 */
export const MessageTurn = memo(function MessageTurn({
  event: e,
  turn,
  actions,
  linkFor,
  busy,
  onTurn,
  found = false,
  lateAfter,
}: {
  event: Extract<ChatEvent, { kind: "message" }>;
  /** Which of the owner's turns it is, by position, or -1 for one that is not theirs to change. */
  turn: number;
  /** What a typed block in KOS's words may do here. */
  actions: BlockActions;
  linkFor: Parameters<typeof OriginLine>[0]["linkFor"];
  busy: boolean;
  /** Edit, retry or fork one of the owner's turns. Kept to one identity by the thread, so a message redraws only when it changes. */
  onTurn: (what: TurnAction, turn: number) => void;
  /** The message a search opened the chat at: lit where it sits. */
  found?: boolean;
  /** When the message above it was said, to tell one sent earlier and answered late. */
  lateAfter?: number;
}): ReactElement {
  const words = turnWords(e.role, e.at, e.text);
  const bubble = e.text && (
    <div className={`bubble bubble--${e.role}${found ? " is-found" : ""}`}>
      {e.quote && <QuoteLine text={e.quote.text} from={e.quote.from} />}
      {e.role === "you" ? (
        <OwnerWords text={e.text} {...(e.at ? { at: e.at } : {})} found={found}>
          <ChatWords role={e.role} text={e.text} actions={actions} />
        </OwnerWords>
      ) : (
        <ChatWords role={e.role} text={e.text} actions={actions} />
      )}
    </div>
  );
  return (
    <Timed className={`turn turn--${e.role}`} label={words.label}>
      {bubble && e.role !== "kos" ? (
        <div className="turn-said">
          {e.role === "you" && e.at ? <MessageTime at={e.at} /> : null}
          {bubble}
          {e.role === "system" && e.at ? <MessageTime at={e.at} /> : null}
        </div>
      ) : (
        bubble
      )}
      {e.role === "you" && answeredLate(e.at, lateAfter) && (
        <span className="turn-late">Sent {clockWords(e.at!)}, before the messages above; answered after them.</span>
      )}
      {e.origin && <OriginLine origin={e.origin} {...(linkFor ? { linkFor } : {})} />}
      {/* Outside the bubble, under it: an attachment is a thing that came
          with the message, not part of the sentence. The files the message
          mentions sit there too, for the same reason. */}
      {e.attachments && e.attachments.length > 0 && <AttachmentStrip items={e.attachments} />}
      {e.text && e.role !== "system" && <MentionedFiles text={e.text} />}
      {e.text && e.role !== "system" && (
        <MessageActions
          text={e.text}
          of={words.of}
          busy={busy}
          {...(e.role === "kos" && e.at ? { at: e.at } : {})}
          {...(turn >= 0
            ? { onEdit: () => onTurn("edit", turn), onRetry: () => onTurn("retry", turn), onFork: () => onTurn("fork", turn) }
            : {})}
        />
      )}
    </Timed>
  );
});
