import type { ReactElement } from "react";

import { AlertIcon, WorkingDots } from "@kos/kit";

import type { Reach } from "./reach.js";

/**
 * One pill over the top of the page when KOS is not there for this tab: not
 * answering (the dashboard keeps asking, and the line goes when KOS is back),
 * or restarted under a page that can no longer prove its changes, which only
 * a reload mends. Nothing typed is lost either way: the composer and the
 * forms keep their words.
 */
export function HostBanner({ reach }: { reach: Reach }): ReactElement | null {
  if (reach.stale) {
    return (
      <div className="host-banner host-banner--stale" role="alert">
        <span className="host-banner-mark" aria-hidden="true">
          <AlertIcon size={12} />
        </span>
        <span className="host-banner-text">KOS restarted. Reload to keep working.</span>
        <button type="button" className="btn btn--sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  if (!reach.down) return null;
  return (
    <div className="host-banner" role="status">
      <span className="host-banner-mark" aria-hidden="true">
        <AlertIcon size={12} />
      </span>
      <span className="host-banner-text">KOS is not answering. Retrying</span>
      <WorkingDots />
    </div>
  );
}
