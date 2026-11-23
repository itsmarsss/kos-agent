import { useState, type ReactElement } from "react";

import { CheckIcon, CopyIcon, EditIcon, ForkIcon, IconButton, MessageTime, RetryIcon } from "@kos/kit";

import { toast } from "./Toast.js";

/**
 * What you can do with a message you sent, or one you got back.
 *
 * Shown on hover so a thread reads as a conversation rather than a toolbar per
 * line. Retry, edit and fork are the same operation underneath: rewind to this
 * point and run again, either in place or into a copy.
 */

export interface MessageActionProps {
  text: string;
  /** What the buttons act on, in their names: "KOS's reply, 6:52 PM". */
  of: string;
  /** Absent on an assistant turn, which can only be copied. */
  onEdit?: (next: string) => void;
  onRetry?: () => void;
  onFork?: () => void;
  busy?: boolean;
  /** When KOS's message was said: its time ends the row, as the owner's sits beside their bubble. */
  at?: number;
}

export function MessageActions({
  text,
  of,
  onEdit,
  onRetry,
  onFork,
  busy,
  at,
}: MessageActionProps): ReactElement {
  const [copied, setCopied] = useState(false);

  // Said as well as shown: a tick alone on a phone, where the pointer is not over it, read as nothing happening.
  const copy = (): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        toast({ kind: "ok", text: `Copied ${of.replace(/ “.*$|,[^,]*$/, "")}` });
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => toast({ kind: "err", text: "Could not copy: this browser did not allow it" }));
  };

  return (
    <div className="acts">
      <IconButton label={copied ? `Copied ${of}` : `Copy ${of}`} title={copied ? "Copied" : "Copy"} onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
      {onEdit && (
        <IconButton label={`Edit ${of}`} title="Edit" disabled={busy} onClick={() => onEdit(text)}>
          <EditIcon />
        </IconButton>
      )}
      {onRetry && (
        <IconButton label={`Retry ${of}`} title="Retry" disabled={busy} onClick={onRetry}>
          <RetryIcon />
        </IconButton>
      )}
      {onFork && (
        <IconButton label={`Fork from ${of}`} title="Fork" disabled={busy} onClick={onFork}>
          <ForkIcon />
        </IconButton>
      )}
      {at ? <MessageTime at={at} /> : null}
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
