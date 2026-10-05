import { useState, type ReactElement } from "react";

import { ChevronDown, ChevronRight } from "./icons.js";

/**
 * What the model worked out before answering, kept in the transcript.
 *
 * Collapsed by default, because the answer is what you came for, and readable
 * afterwards, because when an agent does something surprising the reasoning is
 * the only place the why is written down. Live streaming shows the current
 * line; this is the whole of it, kept.
 */
export function Thinking({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const lines = text.trim().split("\n").filter((l) => l.trim() !== "");
  const first = lines[0]?.replace(/\*\*/g, "").trim() ?? "";

  return (
    <div className={`thinking ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="thinking-caret">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <span className="thinking-label">Thought</span>
        {!open && <span className="thinking-peek">{first}</span>}
      </button>
      {open && (
        <div className="thinking-body">
          {lines.map((line, i) => (
            <p key={i}>{line.replace(/\*\*/g, "")}</p>
          ))}
        </div>
      )}
    </div>
  );
}
