import { useState, type ReactElement } from "react";

/**
 * What you can do with a message you sent, or one you got back.
 *
 * Shown on hover so a thread reads as a conversation rather than a toolbar per
 * line. Retry, edit and fork are the same operation underneath: rewind to this
 * point and run again, either in place or into a copy.
 */

export interface MessageActionProps {
  text: string;
  /** Absent on an assistant turn, which can only be copied. */
  onEdit?: (next: string) => void;
  onRetry?: () => void;
  onFork?: () => void;
  busy?: boolean;
}

export function MessageActions({
  text,
  onEdit,
  onRetry,
  onFork,
  busy,
}: MessageActionProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div className="acts">
      <button type="button" className="acts-btn" onClick={copy}>
        {copied ? "copied" : "copy"}
      </button>
      {onEdit && (
        <button
          type="button"
          className="acts-btn"
          disabled={busy}
          onClick={() => onEdit(text)}
        >
          edit
        </button>
      )}
      {onRetry && (
        <button type="button" className="acts-btn" disabled={busy} onClick={onRetry}>
          retry
        </button>
      )}
      {onFork && (
        <button type="button" className="acts-btn" disabled={busy} onClick={onFork}>
          fork
        </button>
      )}
    </div>
  );
}

/** The inline editor a message turns into while being changed. */
export function MessageEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}): ReactElement {
  const [text, setText] = useState(initial);
  return (
    <div className="edit">
      <textarea
        className="edit-area"
        value={text}
        autoFocus
        rows={Math.min(12, Math.max(2, text.split("\n").length + 1))}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="edit-bar">
        <button
          type="button"
          className="btn btn--primary"
          disabled={text.trim() === ""}
          onClick={() => onSubmit(text)}
        >
          Send
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <span className="hint">Replaces this message and everything after it.</span>
      </div>
    </div>
  );
}
