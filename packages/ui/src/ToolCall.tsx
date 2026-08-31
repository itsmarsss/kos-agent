import { useState, type ReactElement } from "react";

import type { ChatEvent } from "./api.js";

/**
 * A tool call in the transcript. Collapsed it is one line saying what the
 * agent did; expanded it shows the arguments and what came back.
 *
 * Showing these at all is the point: an agent that only surfaces its
 * conclusions is one you have to take on faith, and the audit log lives on a
 * different page from the sentence that made you curious.
 */
export function ToolCall({
  event,
  awaitingApproval,
  onDecide,
}: {
  event: Extract<ChatEvent, { kind: "tool" }>;
  /** True while its pending action is still undecided. */
  awaitingApproval?: boolean;
  onDecide?: (pendingId: string, approved: boolean) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const running = event.result === undefined;
  const queued = event.pendingId !== undefined;

  // A queued call did not fail, but it did not happen either. Calling that
  // "ok" is how a risky tool looks like a tool that silently does nothing.
  const state = running
    ? "…"
    : event.isError
      ? "failed"
      : queued
        ? awaitingApproval
          ? "needs you"
          : "approved"
        : "ok";

  return (
    <div
      className={`toolcall ${event.isError ? "is-error" : ""} ${
        queued && awaitingApproval ? "is-queued" : ""
      }`}
    >
      <button
        type="button"
        className="toolcall-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="toolcall-caret">{open ? "▾" : "▸"}</span>
        <code className="toolcall-name">{event.name}</code>
        <span className="toolcall-summary">{event.summary}</span>
        <span className="toolcall-state">{state}</span>
      </button>

      {queued && awaitingApproval && onDecide && (
        <div className="toolcall-approve">
          <span>This needs your approval before it runs.</span>
          <button
            type="button"
            className="btn btn--ok"
            onClick={() => onDecide(event.pendingId!, true)}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn btn--danger-ghost"
            onClick={() => onDecide(event.pendingId!, false)}
          >
            Deny
          </button>
        </div>
      )}

      {open && (
        <div className="toolcall-body">
          <div className="toolcall-part">
            <span className="toolcall-label">Arguments</span>
            <pre>{JSON.stringify(event.args, null, 2)}</pre>
          </div>
          {!running && (
            <div className="toolcall-part">
              <span className="toolcall-label">
                {event.isError ? "Error" : "Result"}
              </span>
              <pre>{event.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
