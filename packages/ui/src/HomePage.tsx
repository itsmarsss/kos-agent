import { useEffect, useRef, useState, type ReactElement } from "react";
import type { HomeLayout, HomePanel, PanelKind } from "@kos/shared";

import { AnimatePresence, m } from "motion/react";

import { api, type FailingJob, type HomeData } from "./api.js";
import { HomeGrid } from "./HomeGrid.js";
import { Panel } from "./HomePanels.js";
import { ease } from "./motion.js";

/**
 * The first thing you see, arranged by you.
 *
 * Home used to be a project grid, which duplicated the Projects page and
 * answered a question nobody arrives with. What you actually want on opening
 * KOS is what needs a decision, what is running, and what broke while you were
 * away, and which of those matters most depends on how you use it. So it is a
 * layout rather than a page: panels you drag into place and pull to size.
 *
 * Stored as owner settings rather than as a project page, because it is
 * configuration rather than content, and because the widgets a project page
 * offers are all backed by a SQL query against that project's tables. What
 * belongs here lives in the app, not in any project.
 */

const CATALOGUE: { kind: PanelKind; label: string; blurb: string }[] = [
  { kind: "approvals", label: "Needs you", blurb: "Actions waiting on a decision" },
  { kind: "pulse", label: "Last 24 hours", blurb: "Tool calls by the hour" },
  { kind: "agents", label: "Agents", blurb: "Coding sub-agents running now" },
  { kind: "failures", label: "What broke", blurb: "Jobs failing now, and the run strip" },
  { kind: "map", label: "Map", blurb: "KOS, its modules and its projects" },
  { kind: "activity", label: "Activity", blurb: "Recent tool calls" },
  { kind: "projects", label: "Projects", blurb: "What KOS is keeping for you" },
  { kind: "chats", label: "Chats", blurb: "Recent conversations" },
  { kind: "schedule", label: "Schedule", blurb: "What runs on its own, and when next" },
  { kind: "spend", label: "Spend", blurb: "Tokens this week, by day and by model" },
  { kind: "memory", label: "Memory", blurb: "What KOS holds, has not read, and asks you about" },
  { kind: "modules", label: "Modules", blurb: "Which modules are on and connected" },
  { kind: "note", label: "Note", blurb: "Text you write yourself" },
];

export function HomePage({
  onOpenChat,
  onGo,
  onDecide,
  deciding,
  onDismissFailure,
  onOpenFailure,
  onFixFailure,
}: {
  onOpenChat: (id: string) => void;
  onGo: (to: "agents" | "history" | "projects" | "crons" | "chats" | "settings" | "memory", section?: string) => void;
  onDecide: (id: number, approved: boolean, remember?: boolean) => void;
  deciding: ReadonlySet<number>;
  onDismissFailure: (key: string) => void;
  onOpenFailure: (key: string) => void;
  onFixFailure: (failure: FailingJob) => void;
}): ReactElement {
  const [data, setData] = useState<HomeData | null>(null);
  const [layout, setLayout] = useState<HomeLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Arrangements in flight: a panel being carried, and saves not yet
   * answered. While either is true the poll keeps its hands off the layout,
   * or a refresh would put the panel back where it was picked up from.
   */
  const dragging = useRef(false);
  const saving = useRef(0);

  const load = (): void => {
    void api
      .home()
      .then((r) => {
        setData(r);
        const hold = editing || dragging.current || saving.current > 0;
        setLayout((current) => (hold && current ? current : r.layout));
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // Reading `editing` inside load keeps the poll from clobbering an edit.
  }, [editing]);

  const save = (next: HomeLayout): void => {
    setLayout(next);
    saving.current += 1;
    void api
      .saveHome(next)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => {
        saving.current -= 1;
      });
  };

  const arrange = (panels: HomePanel[], commit: boolean): void => {
    dragging.current = !commit;
    if (commit) save({ panels });
    else setLayout({ panels });
  };

  const update = (id: string, change: Partial<HomePanel>): void => {
    if (!layout) return;
    save({
      panels: layout.panels.map((p) => (p.id === id ? { ...p, ...change } : p)),
    });
  };

  const remove = (id: string): void => {
    if (!layout) return;
    save({ panels: layout.panels.filter((p) => p.id !== id) });
  };

  const add = (kind: PanelKind): void => {
    if (!layout) return;
    // Ids stay unique across repeated adds of the same kind, so two notes can
    // coexist and the editor can still tell them apart.
    const id = `${kind}-${Date.now().toString(36)}`;
    save({
      panels: [
        ...layout.panels,
        {
          id,
          kind,
          // The wide ones are wide because they are rows or a diagram; a
          // chart or a short list reads better beside another.
          span: kind === "map" || kind === "approvals" || kind === "projects" ? "full" : "half",
          ...(kind === "note" ? { text: "" } : {}),
        },
      ],
    });
  };

  if (!layout || !data) {
    return (
      <div className="home">
        {error ? (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        ) : (
          <p className="hint">Loading…</p>
        )}
      </div>
    );
  }

  const used = new Set(layout.panels.map((p) => p.kind));

  return (
    <div className="home">
      <header className="home-bar">
        <h1>Overview</h1>
        <span className="home-bar-hint">
          {editing ? "Drag a panel to move it, its edge to resize it." : "Drag a panel by its title to move it."}
        </span>
        <button
          type="button"
          className={`btn ${editing ? "btn--primary" : ""}`}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? "Done" : "Arrange"}
        </button>
      </header>

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      {layout.panels.length === 0 && (
        <p className="hint">
          Nothing on your home page. Press Arrange to put something on it.
        </p>
      )}

      <HomeGrid
        panels={layout.panels}
        editing={editing}
        onChange={arrange}
        onRemove={remove}
        render={(panel) => (
          <Panel
            panel={panel}
            data={data}
            editing={editing}
            onChange={(change) => update(panel.id, change)}
            onOpenChat={onOpenChat}
            onGo={onGo}
            onDecide={onDecide}
            deciding={deciding}
            onDismissFailure={onDismissFailure}
            onOpenFailure={onOpenFailure}
            onFixFailure={onFixFailure}
          />
        )}
      />

      <AnimatePresence>
      {editing && (
        <m.div
          className="home-add"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={ease}
        >
          <span className="home-add-label">Add a panel</span>
          <div className="home-add-list">
            {CATALOGUE.map((c) => (
              <button
                key={c.kind}
                type="button"
                className="home-add-item"
                // Only note repeats: two identical activity lists is a mistake
                // rather than a layout.
                disabled={c.kind !== "note" && used.has(c.kind)}
                onClick={() => add(c.kind)}
              >
                <span className="home-add-name">{c.label}</span>
                <span className="home-add-blurb">{c.blurb}</span>
              </button>
            ))}
          </div>
        </m.div>
      )}
      </AnimatePresence>
    </div>
  );
}
