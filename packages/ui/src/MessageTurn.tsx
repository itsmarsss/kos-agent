import { memo, type ReactElement } from "react";

import { clockWords } from "@kos/shared";
import { type BlockActions, MessageTime, QuoteLine, Timed } from "@kos/kit";

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
export function turnWords(role: "you" | "kos" | "system", at?: number): { label: string; of: string } {
  const when = at ? `, ${clockWords(at)}` : "";
  return { label: `${SAID[role].said}${when}`, of: `${SAID[role].thing}${when}` };
}

/** A message sent before ones above it, answered after them: its turn waited (on an approval, say) while they went through. */
export function answeredLate(at: number | undefined, before: number | undefined): boolean {
  return at !== undefined && before !== undefined && at < before;
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
  const words = turnWords(e.role, e.at);
  const bubble = e.text && (
    <div className={`bubble bubble--${e.role}${found ? " is-found" : ""}`}>
      {e.quote && <QuoteLine text={e.quote.text} from={e.quote.from} />}
      <ChatWords role={e.role} text={e.text} actions={actions} />
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
