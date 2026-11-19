import type { ReactElement } from "react";

import { AlertIcon } from "@kos/kit";

/**
 * Under the owner's bubble when it never reached KOS: that it was not sent,
 * why in words, Retry, and Edit to take it back into the composer. The
 * message is kept here alone, never in the composer as well, so it cannot
 * go twice. While KOS is not answering, Retry waits for it to come back.
 */
export function UnsentNote({ reason, down, onRetry, onEdit }: { reason: string; down: boolean; onRetry: () => void; onEdit: () => void }): ReactElement {
  return (
    <p className="chat-unsent" role="alert">
      <span className="chat-unsent-mark" aria-hidden="true">
        <AlertIcon size={11} />
      </span>
      <span className="chat-unsent-text">Not sent. {reason}</span>
      <button type="button" className="btn btn--sm btn--ghost" onClick={onEdit}>
        Edit
      </button>
      <button type="button" className="btn btn--sm" onClick={onRetry} disabled={down}>
        Retry
      </button>
    </p>
  );
}
