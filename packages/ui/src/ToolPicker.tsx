import type { ReactElement } from "react";

import type { ToolInfo } from "./api.js";

/**
 * Which tool families a chat or an agent may reach, as a list to tick.
 *
 * The scope is in families (browser, files, memory) because that is how it
 * is stored, but each row says what is actually inside: a chip that said
 * only the family name meant already knowing what it covered. Null is the
 * full toolkit; an empty list is no tools at all, which is a real choice.
 */

/** Group tools by their prefix; the scope is expressed in those terms. */
export function familiesOf(tools: ToolInfo[]): string[] {
  const seen = new Set<string>();
  for (const t of tools) seen.add(t.name.split(".")[0] ?? t.name);
  return [...seen].sort();
}

export interface ToolPickerProps {
  tools: ToolInfo[];
  allow: string[] | null;
  onChange: (allow: string[] | null) => void;
}

export function ToolPicker({ tools, allow, onChange }: ToolPickerProps): ReactElement {
  const families = familiesOf(tools);
  const unrestricted = allow === null;
  /** First click on an unrestricted scope starts one containing just that. */
  const toggle = (family: string): void => {
    if (allow === null) {
      onChange([family]);
      return;
    }
    onChange(allow.includes(family) ? allow.filter((f) => f !== family) : [...allow, family]);
  };
  return (
    <div className="toolpick-wrap">
      <div className="toolpick">
        {families.length === 0 && <p className="hint">Loading the toolkit…</p>}
        {families.map((f) => {
          const on = unrestricted || allow.includes(f);
          const owned = tools.filter((t) => t.name.split(".")[0] === f);
          return (
            <label key={f} className={`toolpick-row ${on ? "is-on" : ""}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(f)} />
              <span className="toolpick-main">
                <span className="toolpick-name">{f}</span>
                <span className="toolpick-tools">{owned.map((t) => t.name.split(".")[1] ?? t.name).join(", ") || "no tools"}</span>
              </span>
              <span className="toolpick-count">{owned.length}</span>
            </label>
          );
        })}
      </div>
      <div className="toolpick-foot">
        <span className="hint">
          {unrestricted
            ? "The full toolkit."
            : allow.length === 0
              ? "No tools at all: it can talk, and nothing else."
              : `Only these. ${families.length - allow.length} withheld.`}
        </span>
        {!unrestricted && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(null)}>
            Full toolkit
          </button>
        )}
      </div>
    </div>
  );
}
