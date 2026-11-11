/**
 * kos-sheet's defaults: a quiet grid where the figures are the point.
 * Numbers sit right in tabular figures, the header and the row numbers stay
 * in view, and the focused cell is plain to see. On a phone only the grid
 * scrolls sideways: its box is contained inline there, so however wide the
 * grid, it never widens what holds the sheet (a flex row, an inline block, a
 * grid's auto track), and the page never scrolls sideways. Wider, the box
 * sizes to its grid, so a sheet held by something sized to its content is
 * never clipped, up to the view less the page's gutters, past which the grid
 * scrolls in its box rather than the page sideways. On a phone the grid
 * narrows first, its short words wrapping to two lines at most and its free
 * text cut on one, and past that its key figure holds at the right edge and
 * the tools say how many columns are out of view.
 * It sits on KOS's ground in KOS's face; the dashboard's column gives it its
 * gutter; full screen (data-present), or on a ground of its own
 * (data-ground="own"), it takes its own.
 * Selectors are one class deep, before the agent's own CSS.
 */
export const SHEET_CSS = String.raw`
:where(:root) {
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-display: var(--font-ui);
  --font-body: var(--font-ui);
  --font-mono: var(--mono, ui-monospace, Menlo, monospace);
  --sheet-row: 34px;
  --sheet-height: max(320px, calc(100dvh - 220px));
  --sheet-gutter: 0px;
}
:where(html[data-present], html[data-ground="own"]) { --sheet-gutter: clamp(16px, 3vw, 28px); }
:where(html[data-kind="sheet"]) body { font-family: var(--font-body); background: var(--bg); color: var(--text); padding: var(--sheet-gutter); }

.sheet { position: relative; display: flex; flex-direction: column; gap: 12px; min-width: 0; font: 400 14px / 1.4 var(--font-ui); }
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
.sheet-tools .sheet-more { display: none; }
.sheet-tools .sheet-spacer { flex: 1; }
.sheet-tools button { font: 500 13px / 1 var(--font-ui); color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm, 7px); padding: 8px 12px; cursor: pointer; }
.sheet-tools button:hover { border-color: var(--line-strong, var(--line)); }
.sheet-status { font-size: 13px; color: var(--muted); }
.sheet-status.bad { color: var(--danger); }

/* What the owner decides before anything filled is replaced or deleted, and the import's preview: under the tools, never over the grid. */
.sheet-panel, .sheet-rowbar { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-md, 10px); background: var(--panel); font-size: 13px; color: var(--text); }
/* Never taller than a share of the view, so a short window keeps rows of its grid in sight; what is past it scrolls in the panel. */
.sheet-panel { max-height: min(45vh, 460px); overflow: auto; overscroll-behavior: contain; flex-shrink: 0; }
.sheet-panel.danger { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
.sheet-panel p { margin: 0; }
.sheet-panel-notes { margin: 0; padding-left: 18px; color: var(--muted); display: flex; flex-direction: column; gap: 2px; }
.sheet-panel-refusal { color: var(--danger); }
.sheet-panel-actions, .sheet-rowbar { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; }
.sheet-rowbar { padding: 8px 10px; }
.sheet-rowbar > span { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 4px; }
.sheet-panel button, .sheet-rowbar button { font: 500 13px / 1 var(--font-ui); color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm, 7px); padding: 8px 12px; cursor: pointer; }
.sheet-panel button:hover, .sheet-rowbar button:hover { border-color: var(--line-strong, var(--line)); }
.sheet-panel button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent, #fff); }
:where(.sheet-panel, .sheet-rowbar) button.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
.sheet-panel :where(button, select, input):focus-visible, .sheet-rowbar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sheet-panel select { font: 400 13px / 1.2 var(--font-ui); color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm, 7px); padding: 6px 8px; min-width: 0; max-width: 100%; }
.sheet-import-options { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
.sheet-import-options label { display: inline-flex; flex-direction: row; gap: 6px; align-items: center; font-size: 13px; color: var(--text); }
.sheet-import-options input[type="checkbox"] { width: auto; margin: 0; accent-color: var(--accent); }
.sheet-import-map { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(180px, 100%), 1fr)); gap: 8px 12px; }
.sheet-import-map label { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sheet-import-map span { font: 600 11px / 1.2 var(--font-ui); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); overflow-wrap: anywhere; }
.sheet-import-shown { color: var(--muted); }
.sheet-import-preview { overflow: auto; border: 1px solid var(--line); border-radius: var(--r-sm, 7px); }
.sheet-import-preview table { border-collapse: collapse; width: max-content; min-width: 100%; font-variant-numeric: tabular-nums; }
.sheet-import-preview :where(th, td) { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; max-width: 28ch; overflow: hidden; text-overflow: ellipsis; }
.sheet-import-preview th { background: var(--panel-2); font-weight: 600; font-size: 12px; }
.sheet-import-preview tr:last-child td { border-bottom: 0; }

/* A column's menu, under its header. */
.sheet-menu { position: absolute; z-index: 20; min-width: 200px; padding: 6px; display: flex; flex-direction: column; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md, 10px); box-shadow: var(--float, 0 12px 32px rgba(0, 0, 0, 0.3)); font: 400 13px / 1.2 var(--font-ui); }
.sheet-menu button { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--r-sm, 7px); color: var(--text); cursor: pointer; }
.sheet-menu button:hover, .sheet-menu button:focus-visible { background: var(--panel-2); }
.sheet-menu button.danger { color: var(--danger); }
.sheet-menu button[role="menuitemradio"]::before { content: ""; width: 12px; color: var(--accent); }
.sheet-menu button[aria-checked="true"]::before { content: "\2713"; }
.sheet-menu-group { padding: 8px 10px 4px; font: 600 11px / 1 var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.sheet-menu-note { margin: 0; padding: 6px 10px; max-width: 26ch; color: var(--muted); line-height: 1.35; }
.sheet-menu-rule { height: 1px; margin: 5px 4px; background: var(--line); }

.sheet-scroll { overflow: auto; max-width: calc(100vw - 2 * var(--sheet-gutter)); max-height: var(--sheet-height); border: 1px solid var(--line); border-radius: var(--r-md, 10px); background: var(--panel); overscroll-behavior: contain; }
.sheet-grid { border-collapse: separate; border-spacing: 0; font-variant-numeric: tabular-nums lining-nums; min-width: 100%; width: max-content; }
.sheet-grid :where(th, td) { height: var(--sheet-row); padding: 0 12px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 36ch; text-align: left; background: var(--panel); }
.sheet-grid thead th { position: sticky; top: 0; z-index: 2; background: var(--panel-2); vertical-align: bottom; padding: 6px 0 0; font-weight: 600; min-width: var(--sheet-col, auto); }
.sheet-grid thead button { all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 0 12px 7px; cursor: pointer; }
.sheet-grid thead button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sheet-grid thead .letter { font: 500 10px / 1 var(--font-mono); color: var(--muted); letter-spacing: 0.04em; }
.sheet-grid thead .name { font: 600 12px / 1.2 var(--font-ui); color: var(--text); letter-spacing: 0.01em; display: flex; gap: 4px; align-items: center; }
.sheet-grid thead .name::after { content: ""; color: var(--accent); font-size: 10px; }
.sheet-grid thead th:has(.sheet-colmenu) button:first-child { padding-right: 30px; }
.sheet-grid thead .sheet-colmenu { all: unset; position: absolute; right: 4px; bottom: 5px; width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--r-sm, 7px); color: var(--muted); cursor: pointer; font: 600 14px / 1 var(--font-ui); opacity: 0.55; }
.sheet-grid thead th:hover .sheet-colmenu, .sheet-grid thead .sheet-colmenu:focus-visible, .sheet-grid thead .sheet-colmenu[aria-expanded="true"] { opacity: 1; background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.sheet-grid thead .sheet-colmenu:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sheet-grid thead th.renaming > :not(.sheet-rename) { visibility: hidden; }
.sheet-grid thead .sheet-rename { position: absolute; inset: 4px; box-sizing: border-box; width: auto; padding: 0 8px; font: 600 12px / 1 var(--font-ui); color: var(--text); background: var(--bg); border: 0; border-radius: var(--r-sm, 7px); box-shadow: inset 0 0 0 2px var(--accent); outline: none; }
.sheet-grid thead th[aria-sort="ascending"] .name::after { content: "▲"; }
.sheet-grid thead th[aria-sort="descending"] .name::after { content: "▼"; }
.sheet-grid thead th.num button { align-items: flex-end; }
.sheet-grid .rownum { position: sticky; left: 0; z-index: 1; background: var(--panel-2); color: var(--muted); font: 500 11px / 1 var(--font-mono); text-align: right; padding: 0 10px; min-width: 3.5ch; }
.sheet-grid thead th.rownum { z-index: 3; }
.sheet-grid .rownum .pick { all: unset; display: block; width: 100%; cursor: pointer; text-align: right; border-radius: 4px; }
.sheet-grid .rownum .pick:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sheet-grid .frozen { position: sticky; z-index: 1; }
.sheet-grid thead th.frozen { z-index: 3; }
.sheet-grid .frozen-edge { box-shadow: 1px 0 0 var(--line-strong, var(--line)); }
.sheet-grid td.num, .sheet-grid tfoot td.num { text-align: right; }
.sheet-grid td.err { color: var(--danger); font: 500 12px var(--font-mono); }
.sheet-grid td.bool { text-align: center; color: var(--ok); }
.sheet-grid td.formula { color: var(--text); }
.sheet-grid tbody tr:hover :where(td, th) { background: color-mix(in srgb, var(--accent) 5%, var(--panel)); }
.sheet-grid tbody tr.picked :where(td, th) { background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
.sheet-grid tbody tr.picked .rownum { color: var(--accent); font-weight: 700; }
.sheet-grid td:focus { outline: none; }
.sheet-grid td.focus { box-shadow: inset 0 0 0 2px var(--accent); }
.sheet-grid td.editing { padding: 0; box-shadow: inset 0 0 0 2px var(--accent); }
.sheet-grid td input { all: unset; box-sizing: border-box; width: 100%; min-width: 8ch; height: 100%; padding: 0 10px; font: inherit; color: var(--text); background: var(--bg); }
.sheet-grid td.editing.num input { text-align: right; }
.sheet-grid td input.formula { font-family: var(--font-mono); font-size: 13px; text-align: left; }
.sheet-grid tfoot :where(th, td) { position: sticky; bottom: 0; z-index: 1; background: var(--panel-2); font-weight: 700; border-top: 1px solid var(--line-strong, var(--line)); border-bottom: 0; }
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
  /* More to the right: the grid fades out at the box's right edge, its border does not, and never over the key column held there (the runtime narrows the fade). Phones only, where scrollbars float over the content and leave the fade alone. */
  .sheet-scroll.more { mask: linear-gradient(to left, transparent, #000 var(--sheet-fade, 40px)), linear-gradient(#000 0 0) top / 100% 1px no-repeat, linear-gradient(#000 0 0) bottom / 100% 1px no-repeat, linear-gradient(#000 0 0) right / 1px 100% no-repeat; }
  /* A phone holds four columns, not two: tighter cells, a sigma for the totals' label, and only the row numbers and a frozen first column stay put sideways; the other frozen columns keep their header and total in view. */
  .sheet { font-size: 13px; }
  .sheet-scroll { contain: inline-size; }
  .sheet-grid :where(th, td) { padding: 0 5px; max-width: 14ch; font-size: 13px; }
  /* The grid narrows to the box before it scrolls: words wrap, and a width the sheet asked for is a desktop's. */
  .sheet-grid { width: 100%; }
  .sheet-grid thead th { min-width: 0; }
  .sheet-grid .wrap { white-space: normal; overflow-wrap: break-word; }
  .sheet-grid td.wrap { padding-block: 6px; line-height: 1.25; }
  /* Two lines at most, cut after, so a row is as tall as what reads in it. */
  .sheet-grid td.wrap .lines { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
  /* The key figure holds at the right edge over what it has not reached yet, its shadow saying the columns slide under it. */
  .sheet-grid .key { position: sticky; right: 0; z-index: 1; }
  .sheet-grid thead th.key, .sheet-grid tfoot td.key { z-index: 3; }
  .sheet-scroll.held .sheet-grid .key { overflow: visible; box-shadow: -1px 0 0 var(--line-strong, var(--line)); }
  .sheet-scroll.held .sheet-grid .key::before { content: ""; position: absolute; top: 0; bottom: 0; right: 100%; width: 14px; background: linear-gradient(to left, color-mix(in srgb, #000 22%, transparent), transparent); pointer-events: none; }
  .sheet-tools .sheet-more:not(:empty) { display: inline; color: var(--accent); font: 600 13px / 1 var(--font-ui); }
  .sheet-grid thead button { padding: 0 5px 6px; }
  .sheet-grid .rownum { padding: 0 4px; min-width: 2ch; }
  .sheet-grid tfoot th.rownum .word { display: none; }
  .sheet-grid tfoot th.rownum::after { content: "\03A3"; content: "\03A3" / ""; font: 600 13px / 1 var(--font-ui); letter-spacing: 0; }
  .sheet-grid .frozen:not(:nth-child(2)) { left: auto !important; }
  .sheet-grid .frozen-edge { box-shadow: none; }
  .sheet-grid .frozen:nth-child(2) { max-width: 12ch; box-shadow: 1px 0 0 var(--line-strong, var(--line)); }
  .sheet-tools input { max-width: none; }
}
`;
