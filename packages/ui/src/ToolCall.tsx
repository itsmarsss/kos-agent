import { useState, type ReactElement } from "react";

import type { ChatEvent } from "./api.js";
import { Decision } from "./Decision.js";
import { ChevronDown, ChevronRight } from "./icons.js";

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
  deciding = new Set<number>(),
}: {
  event: Extract<ChatEvent, { kind: "tool" }>;
  /** True while its pending action is still undecided. */
  awaitingApproval?: boolean;
  onDecide?: (pendingId: string, approved: boolean, remember?: boolean) => void;
  /** Ids being decided right now, so the buttons can say so. */
  deciding?: ReadonlySet<number>;
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
        <span className="toolcall-caret">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <code className="toolcall-name">{event.name}</code>
        <span className="toolcall-summary">{event.summary}</span>
        <span className="toolcall-state">{state}</span>
      </button>

      {queued && awaitingApproval && onDecide && (
        <div className="toolcall-approve">
          <span className="toolcall-approve-text">
            This needs your approval before it runs.
          </span>
          <Decision id={Number(event.pendingId)} deciding={deciding} onDecide={(id, ok, remember) => onDecide?.(String(id), ok, remember)} small />
          {/* The arguments, in view while the decision is open: what a
              command is, not that there is one, is what gets approved. */}
          <pre className="toolcall-approve-args">{JSON.stringify(event.args, null, 2)}</pre>
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
