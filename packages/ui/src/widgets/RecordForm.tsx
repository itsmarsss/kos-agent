import type { FormWidget } from "@kos/shared";
import { useState, type FormEvent, type ReactElement } from "react";

import { humanize } from "./format.js";
import { allows, type WidgetProps } from "./types.js";
import { useMutationRunner } from "./useMutationRunner.js";

/**
 * A purpose-built input for one record, not a spreadsheet: one labelled field
 * per declared column, one submit. The spec declares the target; the client
 * sends only the typed values, and the server resolves table and columns from
 * the stored spec.
 */

/** Long-form columns get a textarea; everything else a single-line input. */
const MULTILINE = /(note|notes|description|body|content|comment|summary)$/i;

export function RecordForm({ widget, mutate }: WidgetProps): ReactElement {
  const w = widget as FormWidget;
  const columns = w.mutate?.columns ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const runner = useMutationRunner(mutate);
  const canInsert = allows(w.mutate, "insert");

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    for (const column of columns) {
      const value = values[column];
      // Blank fields are omitted so column defaults and NULL still apply.
      if (value !== undefined && value.trim() !== "") payload[column] = value;
    }
    const ok = await runner.run("insert", payload);
    if (ok) setValues({});
  }

  return (
    <form className="kos-widget kos-form" onSubmit={onSubmit}>
      {w.title ? <div className="kos-widget-title">{w.title}</div> : null}
      {columns.map((column) => (
        <label className="kos-field" key={column}>
          <span className="kos-field-label">{humanize(column)}</span>
          {MULTILINE.test(column) ? (
            <textarea
              className="kos-input"
              rows={3}
              value={values[column] ?? ""}
              onChange={(e) => setValues({ ...values, [column]: e.target.value })}
            />
          ) : (
            <input
              className="kos-input"
              type="text"
              value={values[column] ?? ""}
              onChange={(e) => setValues({ ...values, [column]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="kos-form-bar">
        <button
          className="kos-btn kos-btn--primary"
          type="submit"
          disabled={runner.pending || !canInsert}
        >
          {runner.pending ? "Saving…" : "Save"}
        </button>
        {!canInsert ? (
          <span className="kos-note">this form cannot add records</span>
        ) : null}
        {runner.saved ? <span className="kos-ok">Saved</span> : null}
        {runner.error ? (
          <span className="kos-error" role="alert">
            {runner.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
