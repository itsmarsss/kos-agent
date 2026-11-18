import { useState, type ReactElement } from "react";

import { AnimatePresence, m, useReducedMotion } from "motion/react";

import { pathsIn, stepMechanics, waitWords } from "@kos/shared";
import { ChevronRight, inPlace, spring, StepPicture, StepTime } from "@kos/kit";

import type { ChatEvent, PendingAction } from "./api.js";
import { ArtifactStep, writtenArtifact } from "./ArtifactStep.js";
import { PendingAsk, viewerKeys } from "./PendingAsk.js";
import { hrefFor } from "./routes.js";

/**
 * A step's summary with the file it names openable: "Read blobs/verity/blob.md"
 * goes to the file, as it does from the Discord story. The head is a button,
 * so the path is a link in all but markup: it opens on its own click without
 * toggling the card.
 */
function Summary({ text }: { text: string }): ReactElement {
  return (
    <>
      {pathsIn(text).map((run, i) =>
        run.path ? (
          <span
            key={i}
            role="link"
            tabIndex={0}
            className="toolcall-path"
            title={`Open ${run.path}`}
            onClick={(e) => {
              e.stopPropagation();
              window.location.hash = hrefFor({ name: "files", path: run.path! });
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.stopPropagation();
              window.location.hash = hrefFor({ name: "files", path: run.path! });
            }}
          >
            {run.text}
          </span>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

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
  ask,
  onDecide,
  deciding = new Set<number>(),
}: {
  event: Extract<ChatEvent, { kind: "tool" }>;
  /** Its pending action, while it is still undecided. */
  ask?: PendingAction | undefined;
  onDecide?: (pendingId: string, approved: boolean, remember?: boolean) => void;
  /** Ids being decided right now, so the buttons can say so. */
  deciding?: ReadonlySet<number>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // Reduced motion opens it at once; otherwise it opens to its height, as the kit's drawers do.
  const still = useReducedMotion() === true;
  // An artifact written is shown as itself, not as the step that wrote it.
  const written = writtenArtifact(event);
  if (written) return <ArtifactStep art={written} />;
  const running = event.result === undefined;
  const queued = event.pendingId !== undefined;
  const awaitingApproval = ask !== undefined;
  // A step said by what it is for keeps how it did it here, under the line.
  const mechanics = stepMechanics(event.name, event.args, viewerKeys());

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
        <span className={`toolcall-caret${open ? " is-open" : ""}`}>
          <ChevronRight size={12} />
        </span>
        <code className="toolcall-name">{event.name}</code>
        <span className="toolcall-summary">
          <Summary text={event.summary} />
        </span>
        <span className="toolcall-state">
          <StepTime running={running} startedAt={event.startedAt} ms={event.ms} />
          {state}
        </span>
      </button>
      {event.waitedMs !== undefined && event.waitedMs >= 1_000 && <p className="toolcall-waited">{waitWords(event.waitedMs)}</p>}

      {/* What the step saw (the browser's tab, a computer's screen): the
          evidence for what the reply says it read, small until clicked. */}
      {event.frameId !== undefined && (
        <div className="toolcall-frame">
          <StepPicture src={`/api/frames/${event.frameId}`} caption={event.summary} at={event.startedAt} />
        </div>
      )}

      {ask && onDecide && (
        <div className="toolcall-approve">
          <PendingAsk ask={ask} deciding={deciding} onDecide={(id, ok, remember) => (remember ? onDecide(String(id), ok, true) : onDecide(String(id), ok))} bare>
            {/* The page a browser action is aimed at, when there is one. */}
            {ask.picture && <StepPicture src={`/api/approvals/${ask.id}/picture`} alt="The page this would act on" caption={ask.title ?? ask.summary ?? ask.tool} />}
          </PendingAsk>
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
        <m.div
          className="toolcall-body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: still ? { duration: 0 } : { height: spring, opacity: inPlace.enter } }}
          exit={{ height: 0, opacity: 0, transition: still ? { duration: 0 } : { height: spring, opacity: inPlace.exit } }}
        >
          <div className="toolcall-body-inner">
          {mechanics && (
            <div className="toolcall-part">
              <span className="toolcall-label">Steps</span>
              <pre>{mechanics}</pre>
            </div>
          )}
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
        </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
