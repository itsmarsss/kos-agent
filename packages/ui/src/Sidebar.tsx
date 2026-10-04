import { useEffect, useRef, useState, type ReactElement } from "react";

import type { Status } from "./api.js";
import { hrefFor, NAV, navActive, type Route } from "./routes.js";
import { useDismiss } from "./useDismiss.js";

/**
 * The shell's left edge: where you are, where else you can be, and whether
 * KOS is well.
 *
 * It was a top bar with seven tabs, a health badge, the model name, a Search
 * button and a dots menu, and Settings lived in the menu because the bar had
 * run out of room. A column has room: the nav reads top to bottom, the Inbox
 * carries a count, and the status sits at the foot where a glance finds it
 * without it competing with the page title.
 *
 * On a phone the column is a drawer behind a menu button in a slim bar, the
 * way every chat product does it.
 */
export function Sidebar({
  route,
  status,
  inboxCount,
  busy,
  onSearch,
  onRefresh,
  onSnapshot,
  onOpenWorkspace,
  onCopyWorkspace,
  onToggleKill,
}: {
  route: Route;
  status: Status | null;
  /** Everything waiting on the owner, for the badge beside Inbox. */
  inboxCount: number;
  /** What the shell is doing right now, if anything. */
  busy: string | null;
  onSearch: () => void;
  onRefresh: () => void;
  onSnapshot: () => void;
  onOpenWorkspace: () => void;
  onCopyWorkspace: () => void;
  onToggleKill: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDetailsElement>(null);
  useDismiss(moreRef, moreOpen, () => setMoreOpen(false));
  // Going somewhere closes the drawer; a route change is the signal.
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  const failing = status?.unhealthy ?? 0;
  const healthClass = status?.halted ? "health--halted" : failing > 0 ? "health--bad" : "health--ok";
  const healthText = status?.halted ? "Halted" : failing > 0 ? `${failing} failing` : "Running";
  const model = status?.routes?.["reasoning"];

  return (
    <>
      <header className="phonebar">
        <button type="button" className="phonebar-menu" aria-label="Menu" onClick={() => setOpen(true)}>
          <span className="phonebar-menu-lines" aria-hidden="true" />
          {inboxCount > 0 && <span className="side-badge side-badge--dot" aria-label={`${inboxCount} waiting`} />}
        </button>
        <a className="brand" href="#/">
          K<span>-OS</span>
        </a>
        <button type="button" className="btn btn--ghost phonebar-search" aria-label="Search" onClick={onSearch}>
          ⌘K
        </button>
      </header>
      {open && <div className="side-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />}
      <aside className={`side${open ? " is-open" : ""}`} aria-label="Primary">
        <a className="brand side-brand" href="#/">
          K<span>-OS</span>
        </a>
        <nav className="side-nav">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={hrefFor(item.route)}
              className={`side-link${navActive(item.route, route) ? " is-active" : ""}`}
              aria-current={navActive(item.route, route) ? "page" : undefined}
            >
              {item.label}
              {item.route.name === "inbox" && inboxCount > 0 && <span className="side-badge">{inboxCount}</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <button type="button" className="side-link side-search" onClick={onSearch}>
            Search
            <kbd>⌘K</kbd>
          </button>
          <a
            href={hrefFor({ name: "settings" })}
            className={`side-link${route.name === "settings" ? " is-active" : ""}`}
          >
            Settings
          </a>
          {/* Controlled rather than left to the element: a native details
              stays open over whatever it just opened, and when you click
              elsewhere. */}
          <details
            className="menu side-more"
            ref={moreRef}
            open={moreOpen}
            onToggle={(e) => setMoreOpen(e.currentTarget.open)}
            onClick={(e) => {
              const target = e.target as HTMLElement;
              if (target.closest("button, a")) setMoreOpen(false);
            }}
          >
            <summary className="side-link">More…</summary>
            <div className="menu-body">
              <button type="button" onClick={onRefresh}>Refresh</button>
              <button type="button" onClick={onSnapshot}>Snapshot now</button>
              <button type="button" onClick={onOpenWorkspace}>Open workspace folder</button>
              <button type="button" onClick={onCopyWorkspace}>Copy workspace path</button>
              <button type="button" className="is-danger" onClick={onToggleKill}>
                {status?.halted ? "Resume KOS" : "Halt KOS"}
              </button>
            </div>
          </details>
          {/* Three states, in the order that matters: stopped, broken, fine.
              The old bar said "Running" regardless, so a job that had been
              failing for two days sat behind a green dot. */}
          <a
            className={`health side-health ${healthClass}`}
            href={hrefFor({ name: "home" })}
            title={failing > 0 ? "Something is failing. The overview says what and for how long." : (status?.workspace ?? "")}
          >
            <span className="health-dot" />
            <span className="side-health-text">
              {busy ? `${busy}…` : healthText}
              {model && <span className="side-model" title={`${model.provider} · reasoning turns`}>{model.model}</span>}
            </span>
          </a>
        </div>
      </aside>
    </>
  );
}
