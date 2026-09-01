import type { ListWidget as ListSpec } from "@kos/shared";
import { useState, type ReactElement } from "react";

import { formatCell, humanize, keyColumn, toNumber } from "./format.js";
import { allows, type Row, type WidgetProps } from "./types.js";
import { useMutationRunner } from "./useMutationRunner.js";

/**
 * A list that edits through inline actions - a toggle and a delete button per
 * row - never an editable grid. Adding opens the declared columns as one
 * inline row rather than a separate form. Every action goes through the
 * guarded mutation path, keyed on the row's id column.
 */

const TOGGLE = /^(done|completed?|complete|active|enabled|checked|archived|paid|read)$/i;

function toggleColumn(columns: string[], row: Row | undefined): string | null {
  const named = columns.filter((c) => TOGGLE.test(c));
  // With no rows there is nothing to check the name against, but the add row
  // still needs to know -- and an empty list is exactly when you add the
  // first item, which is where a stray "Done" box would have shown up.
  if (!row) return named[0] ?? null;
  return named.find((c) => c in row) ?? null;
}

export function ListWidget({ widget, rows, mutate }: WidgetProps): ReactElement {
  const w = widget as ListSpec;
  const runner = useMutationRunner(mutate);
  const key = keyColumn(rows[0]);
  const editable = w.mutate?.columns ?? [];
  const toggle = toggleColumn(editable, rows[0]);
  const canToggle = toggle !== null && key !== null && allows(w.mutate, "update");
  const canDelete = key !== null && allows(w.mutate, "delete");
  // The toggle is not something you type. A task list declaring title and
  // done offered a "Done" text box on its add row, where the answer is always
  // no and the column has a default that says so.
  const addable = editable.filter((c) => c !== toggle);
  const canAdd = allows(w.mutate, "insert") && addable.length > 0;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  // A list declaring insert had no way to insert: it only ever toggled and
  // deleted rows that already existed, so a reading list the agent built could
  // never have a book put in it.
  const submit = (): void => {
    const values: Record<string, string> = {};
    for (const column of addable) {
      const v = draft[column]?.trim();
      if (v) values[column] = v;
    }
    if (Object.keys(values).length === 0) return;
    void runner.run("insert", values).then((okay) => {
      if (okay) {
        setDraft({});
        setAdding(false);
      }
    });
  };

  return (
    <div className="kos-widget kos-list">
      {w.title ? <div className="kos-widget-title">{w.title}</div> : null}
      {rows.length === 0 ? <div className="kos-empty">nothing here yet</div> : null}
      <ul className="kos-list-items">
        {rows.map((row, i) => {
          const columns = Object.keys(row);
          const label = columns.find((c) => c !== key && c !== toggle) ?? columns[0];
          const meta = columns.filter((c) => c !== key && c !== toggle && c !== label);
          const on = toggle ? toNumber(row[toggle]) === 1 : false;
          const rowKey =
            key !== null ? { column: key, value: row[key] } : undefined;
          return (
            <li className="kos-list-item" key={i}>
              {canToggle && rowKey && toggle ? (
                <input
                  className="kos-check"
                  type="checkbox"
                  checked={on}
                  disabled={runner.pending}
                  aria-label={`${humanize(toggle)}: ${formatCell(label ? row[label] : "", label)}`}
                  onChange={() =>
                    void runner.run("update", { [toggle]: on ? 0 : 1 }, rowKey)
                  }
                />
              ) : null}
              <span className={on ? "kos-list-label is-done" : "kos-list-label"}>
                {formatCell(label ? row[label] : "", label)}
              </span>
              {meta.length > 0 ? (
                <span className="kos-list-meta">
                  {meta
                    .map((c) => formatCell(row[c], c))
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
              {canDelete && rowKey ? (
                <button
                  className="kos-btn kos-btn--danger"
                  type="button"
                  disabled={runner.pending}
                  onClick={() => void runner.run("delete", undefined, rowKey)}
                >
                  Delete
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canAdd && !adding ? (
        <button
          className="kos-btn"
          type="button"
          onClick={() => {
            runner.reset();
            setAdding(true);
          }}
        >
          + Add
        </button>
      ) : null}

      {canAdd && adding ? (
        <div className="kos-list-add">
          {addable.map((column) => (
            <label className="kos-field" key={column}>
              <span className="kos-field-label">{humanize(column)}</span>
              <input
                className="kos-input"
                type="text"
                value={draft[column] ?? ""}
                onChange={(e) => setDraft({ ...draft, [column]: e.target.value })}
              />
            </label>
          ))}
          <div className="kos-list-add-actions">
            <button
              className="kos-btn kos-btn--primary"
              type="button"
              disabled={runner.pending}
              onClick={submit}
            >
              {runner.pending ? "Saving…" : "Save"}
            </button>
            <button
              className="kos-btn"
              type="button"
              onClick={() => {
                setAdding(false);
                setDraft({});
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {runner.error ? (
        <div className="kos-error" role="alert">
          {runner.error}
        </div>
      ) : null}
    </div>
  );
}
