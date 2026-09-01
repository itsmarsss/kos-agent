import type { CardWidget as CardSpec } from "@kos/shared";
import { useState, type ReactElement } from "react";

import { editValue, formatCell, humanize, keyColumn } from "./format.js";
import { allows, type Row, type WidgetProps } from "./types.js";
import { useMutationRunner } from "./useMutationRunner.js";

/**
 * A gallery of cards that edits by tapping a card open into a clean detail view,
 * plus an add button - the card idiom, not a grid. Save and delete run through
 * the guarded mutation path keyed on the row's id column.
 */

type Selection = { mode: "edit"; index: number } | { mode: "new" } | null;

function initialValues(row: Row | undefined, columns: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const column of columns) values[column] = row ? editValue(row[column]) : "";
  return values;
}

function Detail({
  columns,
  values,
  setValues,
}: {
  columns: string[];
  values: Record<string, string>;
  setValues: (next: Record<string, string>) => void;
}): ReactElement {
  return (
    <>
      {columns.map((column) => (
        <label className="kos-field" key={column}>
          <span className="kos-field-label">{humanize(column)}</span>
          <input
            className="kos-input"
            type="text"
            value={values[column] ?? ""}
            onChange={(e) => setValues({ ...values, [column]: e.target.value })}
          />
        </label>
      ))}
    </>
  );
}

export function CardWidget({ widget, rows, mutate }: WidgetProps): ReactElement {
  const w = widget as CardSpec;
  const editable = w.mutate?.columns ?? [];
  const key = keyColumn(rows[0]);
  const runner = useMutationRunner(mutate);
  const [selected, setSelected] = useState<Selection>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const canAdd = allows(w.mutate, "insert");
  const canEdit = allows(w.mutate, "update") && key !== null;
  const canDelete = allows(w.mutate, "delete") && key !== null;
  const open = (next: Selection, row?: Row): void => {
    runner.reset();
    setValues(initialValues(row, editable));
    setSelected(next);
  };

  const current =
    selected?.mode === "edit" ? rows[selected.index] : undefined;
  const rowKey =
    current && key !== null ? { column: key, value: current[key] } : undefined;

  async function save(): Promise<void> {
    const payload: Record<string, unknown> = {};
    for (const column of editable) {
      const value = values[column];
      if (value !== undefined && value.trim() !== "") payload[column] = value;
    }
    const ok =
      selected?.mode === "new"
        ? await runner.run("insert", payload)
        : await runner.run("update", payload, rowKey);
    if (ok) setSelected(null);
  }

  return (
    <div className="kos-widget kos-cards-widget">
      <div className="kos-widget-head">
        {w.title ? <div className="kos-widget-title">{w.title}</div> : null}
        {canAdd ? (
          <button className="kos-btn" type="button" onClick={() => open({ mode: "new" })}>
            Add
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? <div className="kos-empty">nothing here yet</div> : null}
      <div className="kos-cards">
        {rows.map((row, i) => {
          const entries = Object.entries(row).filter(([c]) => c !== key);
          const [head, ...rest] = entries;
          const body = (
            <>
              <div className="kos-card-title">
                {formatCell(head?.[1], head?.[0])}
              </div>
              {rest.map(([c, v]) => (
                <div className="kos-card-field" key={c}>
                  <span className="kos-card-key">{humanize(c)}</span>
                  <span>{formatCell(v, c)}</span>
                </div>
              ))}
            </>
          );
          return canEdit ? (
            <button
              className="kos-card kos-card--tappable"
              type="button"
              key={i}
              onClick={() => open({ mode: "edit", index: i }, row)}
            >
              {body}
            </button>
          ) : (
            <div className="kos-card" key={i}>
              {body}
            </div>
          );
        })}
      </div>

      {selected ? (
        <div className="kos-detail">
          <div className="kos-detail-head">
            {selected.mode === "new" ? "New record" : "Edit record"}
          </div>
          <Detail columns={editable} values={values} setValues={setValues} />
          <div className="kos-form-bar">
            <button
              className="kos-btn kos-btn--primary"
              type="button"
              disabled={runner.pending}
              onClick={() => void save()}
            >
              {runner.pending ? "Saving…" : "Save"}
            </button>
            <button className="kos-btn" type="button" onClick={() => setSelected(null)}>
              Cancel
            </button>
            {selected.mode === "edit" && canDelete && rowKey ? (
              <button
                className="kos-btn kos-btn--danger"
                type="button"
                disabled={runner.pending}
                onClick={() => {
                  void runner.run("delete", undefined, rowKey).then((ok) => {
                    if (ok) setSelected(null);
                  });
                }}
              >
                Delete
              </button>
            ) : null}
            {runner.error ? (
              <span className="kos-error" role="alert">
                {runner.error}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
