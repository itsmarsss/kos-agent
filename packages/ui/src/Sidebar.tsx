import { useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronLeft, ChevronRight, Face, faceLookOf, IconButton, KOS_SEED, type Mood, Menu, NavIcon, useDismiss, useFocusTrap, useKosLook } from "@kos/kit";

import type { Status } from "./api.js";
import { hrefFor, NAV, navActive, type Route } from "./routes.js";
import { swipedShut } from "./touch.js";

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
/** The drawer's id, for the Menu button that opens it. */
const DRAWER_ID = "side-drawer";

type MoreAction = "refresh" | "snapshot" | "open" | "copy";

/** The More menu's everyday items, each with a line saying what it does; Halt stands apart below them. */
const MORE_ITEMS: { action: MoreAction; label: string; hint: string }[] = [
  { action: "refresh", label: "Refresh", hint: "Read everything on this page again" },
  { action: "snapshot", label: "Snapshot now", hint: "Save a copy of the workspace you can roll back to" },
  { action: "open", label: "Open workspace folder", hint: "Show KOS's folder in Finder" },
  { action: "copy", label: "Copy workspace path", hint: "Copy where KOS's folder is" },
];

export function Sidebar({
  route,
  status,
  down,
  inboxCount,
  busy,
  onSearch,
  onAsk,
  onBrowser,
  browsing,
  onRefresh,
  onSnapshot,
  onOpenWorkspace,
  onCopyWorkspace,
  onToggleKill,
}: {
  route: Route;
  status: Status | null;
  /** KOS has stopped answering this tab: the status above is from before. */
  down: boolean;
  /** (KOS's face is read from context; see @kos/kit's Face.tsx.) */
  /** Everything waiting on the owner, for the badge beside Inbox. */
  inboxCount: number;
  /** What the shell is doing right now, if anything. */
  busy: string | null;
  onSearch: () => void;
  /** Toggle the quick-question window (the floating aside about the open chat). */
  onAsk: () => void;
  onBrowser: () => void;
  /** KOS has the browser open right now. */
  browsing: boolean;
  onRefresh: () => void;
  onSnapshot: () => void;
  onOpenWorkspace: () => void;
  onCopyWorkspace: () => void;
  onToggleKill: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  /** KOS's face, in the brand: bouncing when something waits on you, asleep when halted. */
  const kos = useKosLook();
  const kosMood: Mood = inboxCount > 0 ? "needs-you" : status?.halted ? "asleep" : "idle";
  const [railed, setRailed] = useState(() => {
    try {
      return localStorage.getItem("kos.sidebar") === "rail";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // On the document, so the .app grid can widen the page beside a thin rail.
    if (railed) document.documentElement.dataset["sidebar"] = "rail";
    else delete document.documentElement.dataset["sidebar"];
    try {
      localStorage.setItem("kos.sidebar", railed ? "rail" : "wide");
    } catch {
      // Remembered for this visit only.
    }
  }, [railed]);
  /** Where a finger came down on the drawer: a swipe back toward the edge shuts it, as a phone's drawers do. */
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Going somewhere closes the drawer; a route change is the signal.
  useEffect(() => setOpen(false), [route]);
  // Escape closes the drawer; its backdrop takes the press away.
  useDismiss(open, () => setOpen(false), { away: false, scroll: false, resize: false, escape: "dialog" });
  // Open, the drawer holds the keys as a sheet does, and gives them back to Menu as it shuts.
  const drawer = useRef<HTMLElement>(null);
  useFocusTrap(drawer, open, { onEscape: () => setOpen(false) });

  const failing = status?.unhealthy ?? 0;
  // A status read before KOS stopped answering says nothing about now.
  const healthClass = down ? "health--bad" : status?.halted ? "health--halted" : failing > 0 ? "health--bad" : "health--ok";
  const healthText = down ? "Can't reach KOS" : status?.halted ? "Halted" : failing > 0 ? `${failing} failing` : "All working";
  const actions: Record<MoreAction, () => void> = { refresh: onRefresh, snapshot: onSnapshot, open: onOpenWorkspace, copy: onCopyWorkspace };
  const model = status?.routes?.["reasoning"];

  return (
    <>
      <header className="phonebar">
        <button
          type="button"
          className="phonebar-menu"
          aria-label={inboxCount > 0 ? `Menu, ${inboxCount} waiting` : "Menu"}
          aria-expanded={open}
          aria-controls={DRAWER_ID}
          onClick={() => setOpen(true)}
        >
          <span className="phonebar-menu-lines" aria-hidden="true" />
          {inboxCount > 0 && <span className="side-badge side-badge--dot" aria-hidden="true" />}
        </button>
        <a className="brand" href="#/">
          <Face seed={KOS_SEED} look={faceLookOf(kos)} size={20} mood={kosMood} label="" />
          <span>KOS</span>
        </a>
        {/* A touch screen has no ⌘K: the search is its mark. */}
        <IconButton className="phonebar-search" label="Search" onClick={onSearch}>
          <NavIcon name="search" />
        </IconButton>
      </header>
      {open && <div className="side-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />}
      <aside
        ref={drawer}
        id={DRAWER_ID}
        className={`side${open ? " is-open" : ""}`}
        aria-label={open ? "Menu" : "Sidebar"}
        {...(open ? { role: "dialog", "aria-modal": true } : {})}
        onTouchStart={(e) => {
          const t = e.touches[0];
          swipe.current = t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const from = swipe.current;
          const t = e.changedTouches[0];
          swipe.current = null;
          if (open && from && t && swipedShut(t.clientX - from.x, t.clientY - from.y)) setOpen(false);
        }}
      >
        <div className="side-brand-row">
          <a className="brand side-brand" href="#/">
            <Face seed={KOS_SEED} look={faceLookOf(kos)} size={22} mood={kosMood} label="" />
            <span>KOS</span>
          </a>
          {/* Collapse to a rail. Desktop only; on a phone the sidebar is a
              drawer and this button is hidden. */}
          <IconButton className="side-collapse" label={railed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={railed} title={railed ? "Expand" : "Collapse"} onClick={() => setRailed((v) => !v)}>
            {railed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </IconButton>
        </div>
        <nav className="side-nav" aria-label="Main">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={hrefFor(item.route)}
              className={`side-link${navActive(item.route, route) ? " is-active" : ""}`}
              aria-current={navActive(item.route, route) ? "page" : undefined}
              title={item.label}
            >
              <NavIcon name={item.route.name} />
              <span className="side-label">{item.label}</span>
              {item.route.name === "inbox" && inboxCount > 0 && (
                <>
                  <span className={`side-badge${railed ? " side-badge--dot" : ""}`} aria-hidden="true">{railed ? "" : inboxCount}</span>
                  <span className="sr-only">, {inboxCount} waiting</span>
                </>
              )}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <button type="button" className="side-link side-search" onClick={onSearch} title="Search chats, projects, files and memory, or run a command">
            <NavIcon name="search" />
            <span className="side-label">Search</span>
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="side-link side-search"
            onClick={onAsk}
            title="A quick question about the open chat, without adding to it"
          >
            <NavIcon name="ask" />
            <span className="side-label">Quick ask</span>
            <kbd>⌘⇧K</kbd>
          </button>
          <button
            type="button"
            className={`side-link side-search${browsing ? " is-live" : ""}`}
            onClick={onBrowser}
            title={browsing ? "KOS is browsing: watch" : "Watch KOS's browser"}
          >
            <NavIcon name="browser" />
            <span className="side-label">KOS's browser</span>
            {browsing && <span className="side-live" aria-label="live" />}
          </button>
          <a
            href={hrefFor({ name: "settings" })}
            className={`side-link${route.name === "settings" ? " is-active" : ""}`}
            title="Settings"
          >
            <NavIcon name="settings" />
            <span className="side-label">Settings</span>
          </a>
          <button
            type="button"
            ref={moreRef}
            className="side-link side-more"
            title="More"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <NavIcon name="more" />
            <span className="side-label">More…</span>
          </button>
          <Menu
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            anchor={moreRef}
            label="More"
            side={railed ? "right" : "above"}
            align={railed ? "end" : "start"}
            items={[
              ...MORE_ITEMS.map((item) => ({ label: item.label, hint: item.hint, act: actions[item.action] })),
              {
                label: status?.halted ? "Resume KOS" : "Halt KOS",
                hint: status?.halted ? "Let schedules and chats run again" : "Stop every schedule and chat at once, until you resume",
                act: onToggleKill,
                danger: true,
                divided: true,
              },
            ]}
          />
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
              {/* Its line is kept before the status comes, so the block does not grow under the pointer as it loads. */}
              {model ? (
                <span className="side-model" title={`The model for thinking, from ${model.provider}. Change it in Settings, Models.`}>
                  Thinks with {model.model}
                </span>
              ) : (
                <span className="side-model" aria-hidden="true">
                  {"\u00a0"}
                </span>
              )}
            </span>
          </a>
        </div>
      </aside>
    </>
  );
}
