/**
 * kos-sheet's defaults: a quiet grid where the figures are the point.
 * Numbers sit right in tabular figures, the header and the row numbers stay
 * in view, and the focused cell is plain to see. On a phone only the grid
 * scrolls sideways: its box is contained inline there, so however wide the
 * grid, it never widens what holds the sheet (a flex row, an inline block, a
 * grid's auto track), and the page never scrolls sideways. Wider, the box
 * sizes to its grid, so a sheet held by something sized to its content is
 * never clipped, up to the view less the page's gutters, past which the grid
 * scrolls in its box rather than the page sideways, its right edge fading
 * while there is more to see. Selectors are one class deep, before the agent's own CSS.
 */
export const SHEET_CSS = String.raw`
:where(:root) {
  --font-display: var(--font-public-sans, "Public Sans", -apple-system, "Segoe UI", Roboto, sans-serif);
  --font-body: var(--font-public-sans, "Public Sans", -apple-system, "Segoe UI", Roboto, sans-serif);
  --font-ui: var(--font-public-sans, "Public Sans", -apple-system, "Segoe UI", Roboto, sans-serif);
  --font-mono: var(--font-ibm-plex-mono, "IBM Plex Mono", ui-monospace, Menlo, monospace);
  --sheet-row: 34px;
  --sheet-height: max(320px, calc(100dvh - 220px));
}
:where(html[data-kind="sheet"]) body { font-family: var(--font-body); background: var(--bg); color: var(--text); padding: clamp(16px, 3vw, 28px); }

.sheet { display: flex; flex-direction: column; gap: 12px; min-width: 0; font: 400 14px / 1.4 var(--font-ui); }
.sheet + .sheet { margin-top: 32px; }
.sheet-error { border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger); border-radius: var(--r-sm, 7px); padding: 12px 14px; font: 400 14px / 1.45 var(--font-ui); }

.sheet-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.sheet-tabs button { font: 500 13px / 1 var(--font-ui); color: var(--muted); background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 12px 9px; cursor: pointer; margin-bottom: -1px; }
.sheet-tabs button:hover { color: var(--text); }
.sheet-tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }

.sheet-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sheet-tools input, .sheet-tools select { font: 400 13px / 1.2 var(--font-ui); color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-sm, 7px); padding: 7px 10px; min-width: 0; }
.sheet-tools input { flex: 1 1 180px; max-width: 320px; }
.sheet-tools .sheet-rows { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.sheet-tools .sheet-spacer { flex: 1; }
.sheet-tools button { font: 500 13px / 1 var(--font-ui); color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm, 7px); padding: 8px 12px; cursor: pointer; }
.sheet-tools button:hover { border-color: var(--line-strong, var(--line)); }
.sheet-status { font-size: 13px; color: var(--muted); }
.sheet-status.bad { color: var(--danger); }

.sheet-scroll { overflow: auto; max-width: calc(100vw - 2 * clamp(16px, 3vw, 28px)); max-height: var(--sheet-height); border: 1px solid var(--line); border-radius: var(--r-md, 10px); background: var(--panel); overscroll-behavior: contain; }
/* More to the right: the grid fades out at the box's right edge, its border does not. */
.sheet-scroll.more { mask: linear-gradient(to left, transparent, #000 40px), linear-gradient(#000 0 0) top / 100% 1px no-repeat, linear-gradient(#000 0 0) bottom / 100% 1px no-repeat, linear-gradient(#000 0 0) right / 1px 100% no-repeat; }
.sheet-grid { border-collapse: separate; border-spacing: 0; font-variant-numeric: tabular-nums lining-nums; min-width: 100%; width: max-content; }
.sheet-grid :where(th, td) { height: var(--sheet-row); padding: 0 12px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 36ch; text-align: left; background: var(--panel); }
.sheet-grid thead th { position: sticky; top: 0; z-index: 2; background: var(--panel-2); vertical-align: bottom; padding: 6px 0 0; font-weight: 600; }
.sheet-grid thead button { all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 0 12px 7px; cursor: pointer; }
.sheet-grid thead button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sheet-grid thead .letter { font: 500 10px / 1 var(--font-mono); color: var(--muted); letter-spacing: 0.04em; }
.sheet-grid thead .name { font: 600 12px / 1.2 var(--font-ui); color: var(--text); letter-spacing: 0.01em; display: flex; gap: 4px; align-items: center; }
.sheet-grid thead .name::after { content: ""; color: var(--accent); font-size: 10px; }
.sheet-grid thead th[aria-sort="ascending"] .name::after { content: "▲"; }
.sheet-grid thead th[aria-sort="descending"] .name::after { content: "▼"; }
.sheet-grid thead th.num button { align-items: flex-end; }
.sheet-grid .rownum { position: sticky; left: 0; z-index: 1; background: var(--panel-2); color: var(--muted); font: 500 11px / 1 var(--font-mono); text-align: right; padding: 0 10px; min-width: 3.5ch; }
.sheet-grid thead th.rownum { z-index: 3; }
.sheet-grid .frozen { position: sticky; z-index: 1; }
.sheet-grid thead th.frozen { z-index: 3; }
.sheet-grid .frozen-edge { box-shadow: 1px 0 0 var(--line-strong, var(--line)); }
.sheet-grid td.num, .sheet-grid tfoot td.num { text-align: right; }
.sheet-grid td.err { color: var(--danger); font: 500 12px var(--font-mono); }
.sheet-grid td.bool { text-align: center; color: var(--ok); }
.sheet-grid td.formula { color: var(--text); }
.sheet-grid tbody tr:hover :where(td, th) { background: color-mix(in srgb, var(--accent) 5%, var(--panel)); }
.sheet-grid td:focus { outline: none; }
.sheet-grid td.focus { box-shadow: inset 0 0 0 2px var(--accent); }
.sheet-grid td.editing { padding: 0; box-shadow: inset 0 0 0 2px var(--accent); }
.sheet-grid td input { all: unset; box-sizing: border-box; width: 100%; min-width: 8ch; height: 100%; padding: 0 10px; font: inherit; color: var(--text); background: var(--bg); }
.sheet-grid td.editing.num input { text-align: right; }
.sheet-grid td input.formula { font-family: var(--font-mono); font-size: 13px; text-align: left; }
.sheet-grid tfoot :where(th, td) { position: sticky; bottom: 0; z-index: 1; background: var(--panel-2); font-weight: 650; border-top: 1px solid var(--line-strong, var(--line)); border-bottom: 0; }
.sheet-grid tfoot th.rownum { z-index: 3; font: 600 11px / 1 var(--font-ui); letter-spacing: 0.08em; text-transform: uppercase; }
.sheet-grid tfoot .frozen { z-index: 3; }
.sheet-empty { padding: 28px 16px; color: var(--muted); text-align: center; }

.sheet-charts { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); }
.sheet-charts figure { margin: 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-md, 10px); background: var(--panel); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.sheet-charts figcaption { font: 600 13px / 1.3 var(--font-ui); color: var(--text); }
.sheet-charts .kos-chart { width: 100%; height: auto; display: block; overflow: visible; }
.sheet-charts .kos-chart text { fill: var(--muted); font: 11px var(--font-ui); font-variant-numeric: tabular-nums; }
.sheet-charts .kos-chart .axis { stroke: var(--line); }
@media (max-width: 560px) {
  /* A phone holds four columns, not two: tighter cells, a sigma for the totals' label, and only the row numbers and a frozen first column stay put sideways; the other frozen columns keep their header and total in view. */
  .sheet { font-size: 13px; }
  .sheet-scroll { contain: inline-size; }
  .sheet-grid :where(th, td) { padding: 0 5px; max-width: 14ch; font-size: 13px; }
  .sheet-grid thead button { padding: 0 5px 6px; }
  .sheet-grid .rownum { padding: 0 4px; min-width: 2ch; }
  .sheet-grid tfoot th.rownum .word { display: none; }
  .sheet-grid tfoot th.rownum::after { content: "\03A3" / ""; font: 600 13px / 1 var(--font-ui); letter-spacing: 0; }
  .sheet-grid .frozen:not(:nth-child(2)) { left: auto !important; }
  .sheet-grid .frozen-edge { box-shadow: none; }
  .sheet-grid .frozen:nth-child(2) { max-width: 12ch; box-shadow: 1px 0 0 var(--line-strong, var(--line)); }
  .sheet-tools input { max-width: none; }
}
`;
