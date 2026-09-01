import { type ReactElement } from "react";

/**
 * Approve and deny, in one place.
 *
 * Deciding is not instant: approving runs the tool and then resumes the agent,
 * which is tens of seconds for a real turn and minutes for a build. The
 * buttons said nothing for all of it, so the only thing to do after clicking
 * was wonder whether the click had registered and click again.
 *
 * The button that was pressed says what it is doing and both are disabled
 * while it happens, because the second click was never wanted: the action is
 * already gone from the queue, so it lands on nothing and reports that the
 * action does not exist.
 */
export function Decision({
  id,
  deciding,
  onDecide,
  /** Compact form for a dense list. */
  small,
}: {
  id: number;
  /** Ids currently being decided, so every copy of these buttons agrees. */
  deciding: ReadonlySet<number>;
  onDecide: (id: number, approved: boolean) => void;
  small?: boolean;
}): ReactElement {
  const busy = deciding.has(id);
  const size = small ? " btn--sm" : "";

  return (
    <span className="decision">
      <button
        type="button"
        className={`btn btn--ok${size}`}
        disabled={busy}
        onClick={() => onDecide(id, true)}
      >
        {busy ? (
          <>
            <Spinner />
            Working
          </>
        ) : (
          "Approve"
        )}
      </button>
      <button
        type="button"
        className={`btn btn--danger-ghost${size}`}
        disabled={busy}
        onClick={() => onDecide(id, false)}
      >
        Deny
      </button>
    </span>
  );
}

/** A turning ring. Drawn rather than a character so it spins smoothly. */
function Spinner(): ReactElement {
  return (
    <svg
      className="spinner"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
