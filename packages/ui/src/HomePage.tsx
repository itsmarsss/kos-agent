import { useEffect, useState, type ReactElement } from "react";
import type { HomeLayout, HomePanel, PanelKind, WidgetSpan } from "@kos/shared";

import { AnimatePresence, m } from "motion/react";

import { api, type HomeData } from "./api.js";
import { Panel } from "./HomePanels.js";
import { ease, spring } from "./motion.js";
import { Select } from "./Select.js";

/**
 * The first thing you see, arranged by you.
 *
 * Home used to be a project grid, which duplicated the Projects page and
 * answered a question nobody arrives with. What you actually want on opening
 * KOS is what needs a decision, what is running, and what broke while you were
 * away, and which of those matters most depends on how you use it. So it is a
 * layout rather than a page: panels you add, remove, resize and reorder.
 *
 * Stored as owner settings rather than as a project page, because it is
 * configuration rather than content, and because the widgets a project page
 * offers are all backed by a SQL query against that project's tables. What
 * belongs here lives in the app, not in any project.
 */

const CATALOGUE: { kind: PanelKind; label: string; blurb: string }[] = [
  { kind: "approvals", label: "Needs you", blurb: "Actions waiting on a decision" },
  { kind: "agents", label: "Agents", blurb: "Coding sub-agents running now" },
  { kind: "failures", label: "What broke", blurb: "Recent failed runs" },
  { kind: "activity", label: "Activity", blurb: "Recent tool calls" },
  { kind: "projects", label: "Projects", blurb: "What KOS is keeping for you" },
  { kind: "chats", label: "Chats", blurb: "Recent conversations" },
  { kind: "schedule", label: "Schedule", blurb: "Jobs that run on their own" },
  { kind: "spend", label: "Spend", blurb: "Tokens used this week" },
  { kind: "note", label: "Note", blurb: "Text you write yourself" },
];

const SPAN_OPTIONS: { value: WidgetSpan; label: string }[] = [
  { value: "quarter", label: "Quarter" },
  { value: "third", label: "Third" },
  { value: "half", label: "Half" },
  { value: "full", label: "Full width" },
];

export function HomePage({
  onOpenChat,
  onGo,
  onDecide,
  deciding,
}: {
  onOpenChat: (id: string) => void;
  onGo: (to: "agents" | "runs" | "projects" | "crons" | "chats" | "settings") => void;
  onDecide: (id: number, approved: boolean) => void;
  deciding: ReadonlySet<number>;
}): ReactElement {
  const [data, setData] = useState<HomeData | null>(null);
  const [layout, setLayout] = useState<HomeLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void api
      .home()
      .then((r) => {
        setData(r);
        // While editing, the owner's arrangement wins over whatever the last
        // poll returned; otherwise a refresh mid-edit throws away their work.
        setLayout((current) => (editing && current ? current : r.layout));
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
    void api
      .saveHome(next)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
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

  const move = (id: string, by: -1 | 1): void => {
    if (!layout) return;
    const panels = [...layout.panels];
    const at = panels.findIndex((p) => p.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= panels.length) return;
    [panels[at], panels[to]] = [panels[to]!, panels[at]!];
    save({ panels });
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
          span: kind === "note" ? "half" : "full",
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
        <h1>Home</h1>
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

      <div className="home-grid">
        {layout.panels.map((panel, i) => (
          /* Laid out rather than snapped: moving a panel up or changing its
             width is a spatial change, and seeing it travel is what tells you
             the thing you pressed did what you meant. */
          <m.section
            key={panel.id}
            layout
            className={`home-cell home-cell--${panel.span}`}
            transition={spring}
          >
            {editing && (
              <div className="home-edit">
                <Select
                  className="home-span"
                  label="Width"
                  value={panel.span}
                  options={SPAN_OPTIONS}
                  onChange={(v) => update(panel.id, { span: v as WidgetSpan })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => move(panel.id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Move down"
                  disabled={i === layout.panels.length - 1}
                  onClick={() => move(panel.id, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  title="Remove"
                  onClick={() => remove(panel.id)}
                >
                  ✕
                </button>
              </div>
            )}
            <Panel
              panel={panel}
              data={data}
              editing={editing}
              onChange={(change) => update(panel.id, change)}
              onOpenChat={onOpenChat}
              onGo={onGo}
              onDecide={onDecide}
              deciding={deciding}
            />
          </m.section>
        ))}
      </div>

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
