/**
 * What kos-sheet shows over its grid while the owner decides something: a
 * bar that asks before anything filled is replaced or deleted (the frame
 * refuses window.confirm, and a dialog would hide what it is about), a
 * column's menu, the preview of a CSV import, and a row opened at a narrow
 * width with every field labelled. Built from the runtime's
 * own elements, every piece of what came in set as text, never markup.
 */

import type { SheetColumn, SheetColumnType } from "@kos/shared";

import type { RowReport } from "./sheet.js";
import { DELIMITERS, type Delimiter } from "./sheetimport.js";
import { el } from "./runtime.js";

export interface Action {
  label: string;
  run: () => void;
  tone?: "primary" | "danger";
}

/** How many notes a bar lists before it says how many more there are. */
const NOTES_SHOWN = 5;

function buttons(actions: readonly Action[]): HTMLElement {
  const row = el("div", { class: "sheet-panel-actions" });
  for (const a of actions) {
    const b = el("button", { type: "button", class: a.tone }, a.label);
    b.addEventListener("click", a.run);
    row.append(b);
  }
  return row;
}

function notes(lines: readonly string[]): HTMLElement | null {
  if (!lines.length) return null;
  const list = el("ul", { class: "sheet-panel-notes" });
  for (const line of lines.slice(0, NOTES_SHOWN)) list.append(el("li", {}, line));
  if (lines.length > NOTES_SHOWN) list.append(el("li", {}, `and ${lines.length - NOTES_SHOWN} more`));
  return list;
}

/** A bar under the tools: what is about to happen or what happened, the details, and the choices. */
export function inlineBar(message: string, details: readonly string[], actions: readonly Action[], danger = false): HTMLElement {
  return el("section", { class: `sheet-panel sheet-bar${danger ? " danger" : ""}`, role: "alertdialog", "aria-label": message }, el("p", {}, message), notes(details), buttons(actions));
}

export type MenuItem = { label: string; run: () => void; tone?: "danger"; checked?: boolean } | { group: string } | { note: string } | "-";

/** A column's menu: items, a group's heading, a note, and rules between. Arrow keys move along it. */
export function menu(label: string, items: readonly MenuItem[]): HTMLElement {
  const box = el("div", { class: "sheet-menu", role: "menu", "aria-label": label });
  for (const item of items) {
    if (item === "-") box.append(el("div", { class: "sheet-menu-rule", role: "separator" }));
    else if ("group" in item) box.append(el("div", { class: "sheet-menu-group", role: "presentation" }, item.group));
    else if ("note" in item) box.append(el("p", { class: "sheet-menu-note", role: "presentation" }, item.note));
    else {
      const radio = item.checked !== undefined;
      const b = el("button", { type: "button", role: radio ? "menuitemradio" : "menuitem", class: item.tone, "aria-checked": radio ? String(item.checked) : undefined, tabindex: "-1" }, item.label);
      b.addEventListener("click", item.run);
      box.append(b);
    }
  }
  box.addEventListener("keydown", (e) => {
    const all = [...box.querySelectorAll<HTMLButtonElement>("button")];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      all[(at + step + all.length) % all.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      all[e.key === "Home" ? 0 : all.length - 1]?.focus();
    }
  });
  return box;
}

/** The types a column may have, in the words the menu uses. */
export const TYPE_WORDS: readonly [SheetColumnType, string][] = [
  ["text", "Text"],
  ["number", "Number"],
  ["currency", "Currency"],
  ["percent", "Percent"],
  ["date", "Date"],
  ["bool", "Yes or no"],
];

const DELIMITER_WORDS: Record<Delimiter, string> = { ",": "Comma", ";": "Semicolon", "\t": "Tab" };

/** What the import preview shows, worked out by the runtime. */
export interface ImportView {
  file: string;
  delimiter: Delimiter;
  header: boolean;
  /** The file's columns by their header, or numbered. */
  fields: string[];
  /** For each of the tab's columns, the field that fills it (-1 none). */
  map: number[];
  columns: SheetColumn[];
  /** The first rows as they will show, and how many there are. */
  preview: string[][];
  count: number;
  errors: string[];
  /** Why the rows cannot be added, when they cannot. */
  refusal?: string;
}

export interface ImportHandlers {
  delimiter: (d: Delimiter) => void;
  header: (on: boolean) => void;
  map: (column: number, field: number) => void;
  add: () => void;
  cancel: () => void;
}

/** The preview of a CSV import: how to read it, which of its columns fills each of the tab's, the first rows, and Add. */
export function importPanel(view: ImportView, on: ImportHandlers): HTMLElement {
  const sep = el("select", { "aria-label": "Separator" }, ...DELIMITERS.map((d) => el("option", { value: d }, DELIMITER_WORDS[d])));
  sep.value = view.delimiter;
  sep.addEventListener("change", () => on.delimiter(sep.value as Delimiter));
  const head = el("input", { type: "checkbox" });
  head.checked = view.header;
  head.addEventListener("change", () => on.header(head.checked));
  const options = el("div", { class: "sheet-import-options" }, el("label", {}, "Separator ", sep), el("label", {}, head, " First row is a header"));

  const mapping = el("div", { class: "sheet-import-map" });
  view.columns.forEach((c, i) => {
    const pick = el("select", { "aria-label": `Fills ${c.label}` }, el("option", { value: "-1" }, "Leave empty"), ...view.fields.map((f, k) => el("option", { value: String(k) }, f)));
    pick.value = String(view.map[i] ?? -1);
    pick.addEventListener("change", () => on.map(i, Number(pick.value)));
    mapping.append(el("label", {}, el("span", {}, c.label), pick));
  });

  const table = el("table", {}, el("thead", {}, el("tr", {}, ...view.columns.map((c) => el("th", { scope: "col" }, c.label)))), el("tbody", {}, ...view.preview.map((row) => el("tr", {}, ...row.map((v) => el("td", {}, v))))));
  const shown = view.count > view.preview.length ? `The first ${view.preview.length} of ${view.count} rows` : `${view.count} row${view.count === 1 ? "" : "s"}`;
  const misfits = view.errors.length ? el("p", {}, `${view.errors.length} value${view.errors.length === 1 ? " does" : "s do"} not fit ${view.errors.length === 1 ? "its column" : "their columns"} and will be left empty:`) : null;
  const add: Action = { label: view.count === 1 ? "Add 1 row" : `Add ${view.count} rows`, run: on.add, tone: "primary" };
  const actions = buttons(view.refusal || !view.count ? [{ label: "Cancel", run: on.cancel }] : [add, { label: "Cancel", run: on.cancel }]);
  return el(
    "section",
    { class: "sheet-panel sheet-import", role: "dialog", "aria-label": `Import ${view.file}` },
    el("p", {}, el("strong", {}, `Import ${view.file}`), ` · adds its rows after the last`),
    options,
    mapping,
    el("p", { class: "sheet-import-shown" }, view.count ? shown : "No rows to add."),
    view.count ? el("div", { class: "sheet-import-preview" }, table) : null,
    view.refusal ? el("p", { class: "sheet-panel-refusal", role: "alert" }, view.refusal) : null,
    misfits,
    notes(view.errors),
    actions,
  );
}

/**
 * A row read at a narrow width: a sheet up from the frame's foot, full width,
 * its title and Close over a list of every field, label then value. Escape,
 * Close or a press outside it closes it; the focus stays in it while open.
 */
export function rowDetail(row: RowReport, close: () => void): HTMLElement {
  const shut = el("button", { type: "button" }, "Close");
  shut.addEventListener("click", close);
  const list = el("dl", {});
  for (const f of row.fields) list.append(el("div", {}, el("dt", {}, f.label), el("dd", { class: f.numeric ? "num" : undefined }, f.value || "\u2014")));
  const box = el("section", { class: "sheet-detail-box", role: "dialog", "aria-modal": "true", "aria-label": row.title }, el("header", {}, el("h2", {}, row.title), shut), list);
  const shade = el("div", { class: "sheet-detail" }, box);
  shade.addEventListener("click", (e) => {
    if (e.target === shade) close();
  });
  shade.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key !== "Tab") return;
    e.preventDefault();
    shut.focus();
  });
  return shade;
}
