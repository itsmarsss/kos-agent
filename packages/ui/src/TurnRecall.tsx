import { useRef, useState, type ReactElement } from "react";

import type { TurnRecall as Recall } from "./api.js";
import { useDismiss } from "./useDismiss.js";

/**
 * What the last turn was given from memory.
 *
 * Memory is sent to the model and then stripped from the transcript, so until
 * now the only way to see what KOS remembered for a turn was to read the
 * prompt. A chip says how much came along; opening it says what, with the
 * scope each claim came from, so a wrong or stale claim can be found from
 * the conversation it misled.
 */
export function TurnRecall({ recalled }: { recalled: Recall }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const facts = recalled.facts.length;
  const moments = recalled.events.length;
  if (facts === 0 && moments === 0) {
    return (
      <span className="recall recall--none" title="Nothing in memory matched the last message.">
        memory: nothing matched
      </span>
    );
  }
  const parts = [
    facts > 0 ? `${facts} ${facts === 1 ? "claim" : "claims"}` : null,
    moments > 0 ? `${moments} ${moments === 1 ? "moment" : "moments"}` : null,
  ].filter(Boolean);

  return (
    <div className="recall" ref={ref}>
      <button
        type="button"
        className={`recall-chip${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="What the last turn was given from memory"
      >
        memory: {parts.join(" · ")}
      </button>
      {open && (
        <div className="recall-pop" role="dialog" aria-label="Recalled for the last turn">
          {recalled.projectSlug && (
            <p className="recall-scope">Project in play: {recalled.projectSlug}</p>
          )}
          {facts > 0 && (
            <ul className="recall-list">
              {recalled.facts.map((f) => (
                <li key={f.id}>
                  <span className="recall-key">{f.key}</span>
                  <span className="recall-value">{f.value}</span>
                  <span className="recall-meta">
                    {f.scope === "global" ? "everywhere" : f.scope.replace(/^project:/, "project ").replace(/^caller:/, "caller ")}
                    {f.pinned ? " · pinned" : ""}
                    {f.trust !== "owner" ? ` · ${f.trust}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {moments > 0 && (
            <>
              <p className="recall-head">From the log</p>
              <ul className="recall-list">
                {recalled.events.map((e) => (
                  <li key={e.id}>
                    <span className="recall-meta">{e.role}</span>
                    <span className="recall-value">{e.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
