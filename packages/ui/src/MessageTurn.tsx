import { memo, type ReactElement } from "react";

import { type BlockActions, MessageTime, QuoteLine, Timed } from "@kos/kit";

import type { ChatEvent } from "./api.js";
import { AttachmentStrip } from "./AttachmentStrip.js";
import { ChatWords } from "./ChatWords.js";
import { MentionedFiles } from "./MentionedFiles.js";
import { MessageActions } from "./MessageActions.js";
import { OriginLine } from "./OriginLine.js";

/** What the owner can do to one of their own turns. */
export type TurnAction = "edit" | "retry" | "fork";

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
}): ReactElement {
  const bubble = e.text && (
    <div className={`bubble bubble--${e.role}`}>
      {e.quote && <QuoteLine text={e.quote.text} from={e.quote.from} />}
      <ChatWords role={e.role} text={e.text} actions={actions} />
    </div>
  );
  return (
    <Timed className={`turn turn--${e.role}`}>
      {bubble && e.role !== "kos" ? (
        <div className="turn-said">
          {e.role === "you" && e.at ? <MessageTime at={e.at} /> : null}
          {bubble}
          {e.role === "system" && e.at ? <MessageTime at={e.at} /> : null}
        </div>
      ) : (
        bubble
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
