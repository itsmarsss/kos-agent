import type { ReactElement } from "react";

import { AlertIcon } from "@kos/kit";

/**
 * Under the owner's bubble when it never reached KOS: that it was not sent,
 * why in words, and Retry, with the words back in the composer meanwhile.
 * While KOS is not answering, Retry waits for it to come back.
 */
export function UnsentNote({ reason, down, onRetry }: { reason: string; down: boolean; onRetry: () => void }): ReactElement {
  return (
    <p className="chat-unsent" role="alert">
      <AlertIcon size={12} />
      <span className="chat-unsent-text">Not sent. {reason}</span>
      <button type="button" className="btn btn--sm btn--ghost" onClick={onRetry} disabled={down}>
        Retry
      </button>
    </p>
  );
}
