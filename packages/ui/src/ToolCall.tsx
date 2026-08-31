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
}: {
  event: Extract<ChatEvent, { kind: "tool" }>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const pending = event.result === undefined;

  return (
    <div className={`toolcall ${event.isError ? "is-error" : ""}`}>
      <button
        type="button"
        className="toolcall-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="toolcall-caret">{open ? "▾" : "▸"}</span>
        <code className="toolcall-name">{event.name}</code>
        <span className="toolcall-summary">{event.summary}</span>
        <span className="toolcall-state">
          {pending ? "…" : event.isError ? "failed" : "ok"}
        </span>
      </button>

      {open && (
        <div className="toolcall-body">
          <div className="toolcall-part">
            <span className="toolcall-label">Arguments</span>
            <pre>{JSON.stringify(event.args, null, 2)}</pre>
          </div>
          {!pending && (
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
