/**
 * kos-doc's defaults: a reading measure, a modular scale (1.25 on an 18 px
 * body), and the document's furniture, on KOS's ground. The running text is
 * a reading serif; the title, headings, labels and tables are KOS's own face,
 * so a doc reads as part of the dashboard. Every selector is wrapped in
 * :where() or kept to one class, and the sheet sits before the agent's own
 * CSS, so the artifact restyles anything without fighting it. Colours are
 * KOS's tokens. The dashboard's column gives the doc its gutter; full screen
 * (data-present) it takes its own.
 */
export const DOC_CSS = String.raw`
:where(:root) {
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-display: var(--font-ui);
  --font-body: var(--font-newsreader, "Newsreader", "Iowan Old Style", Georgia, serif);
  --font-mono: var(--mono, ui-monospace, Menlo, monospace);
  --doc-measure: 66ch;
  --doc-size: 1.125rem;
  --doc-gutter: 0px;
}
:where(html[data-present]) { --doc-gutter: clamp(16px, 4vw, 40px); }
:where(html[data-kind="doc"]) body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 400 var(--doc-size) / 1.6 var(--font-body); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
/* Light type on a dark ground thins under grayscale smoothing; the platform's own keeps its weight. */
:where(html[data-kind="doc"][data-mode="dark"]) body { -webkit-font-smoothing: auto; -moz-osx-font-smoothing: auto; }

.doc-frame { display: grid; grid-template-columns: minmax(0, 1fr); padding-block: clamp(16px, 3vw, 32px) 64px; }
.doc-frame.has-toc { row-gap: 20px; }
@media (min-width: 1100px) {
  .doc-frame.has-toc { grid-template-columns: 232px minmax(0, 1fr); column-gap: 24px; }
  .doc-frame.has-toc > .doc-toc { grid-column: 1; grid-row: 1 / span 3; }
  .doc-frame.has-toc > :not(.doc-toc) { grid-column: 2; }
}

/* The text column, with room either side for what breaks out of it. */
:where([data-doc]), .doc-notes {
  display: grid;
  grid-template-columns:
    [full-start] minmax(var(--doc-gutter), 1fr)
    [wide-start] minmax(0, 7rem)
    [text-start] min(var(--doc-measure), 100% - 2 * var(--doc-gutter))
    [text-end] minmax(0, 7rem)
    [wide-end] minmax(var(--doc-gutter), 1fr) [full-end];
  min-width: 0;
  counter-reset: kos-figure;
  hanging-punctuation: first last;
}
:where([data-doc], .doc-notes) > * { grid-column: text; min-width: 0; margin: 0; }
:where([data-doc]) > :where(.doc-wide, figure.doc-wide, .doc-table-wide) { grid-column: wide; }
:where([data-doc]) > :where(.doc-full) { grid-column: full; }

:where([data-doc]) :where(p, ul, ol, dl, pre, table, .doc-table) + :where(p, ul, ol, dl, pre, figure, blockquote, aside, .doc-table) { margin-top: 1.1em; }
:where([data-doc]) > :where(p, ul, ol, dl, pre, figure, blockquote, aside, .doc-table, hr) { margin-top: 1.1em; }
:where([data-doc]) :where(p, li) { text-wrap: pretty; }
:where([data-doc]) :where(ul, ol) { padding-left: 1.3em; }
:where([data-doc]) li + li { margin-top: 0.35em; }
:where([data-doc]) li::marker { color: var(--muted); }
:where([data-doc]) a { color: var(--accent); text-underline-offset: 0.18em; text-decoration-thickness: 1px; }
:where([data-doc]) :where(strong, b) { font-weight: 600; }
:where([data-doc]) hr { border: 0; border-top: 1px solid var(--line); margin-block: 2.4em; }

/* The opening: a kicker, the title, the lede, who and when. */
:where([data-doc]) > header { display: flex; flex-direction: column; gap: 14px; padding-bottom: 28px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
:where([data-doc]) .kicker { font: 600 0.75rem / 1.2 var(--font-ui); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0; }
:where([data-doc]) h1 { font: 700 clamp(1.9rem, 1.4rem + 1.6vw, 2.6rem) / 1.12 var(--font-display); letter-spacing: -0.02em; text-wrap: balance; margin: 0; }
:where([data-doc]) .lede { font-size: 1.3em; line-height: 1.45; color: var(--text); opacity: 0.86; text-wrap: pretty; margin: 0; }
:where([data-doc]) .byline { font: 400 0.8125rem / 1.4 var(--font-ui); color: var(--muted); margin: 0; font-variant-numeric: tabular-nums; }

:where([data-doc]) h2 { font: 600 1.4rem / 1.25 var(--font-display); letter-spacing: -0.015em; text-wrap: balance; margin-top: 2.2em; scroll-margin-top: 24px; }
:where([data-doc]) > header + h2 { margin-top: 1.3em; }
:where([data-doc]) h3 { font: 600 1.0625rem / 1.3 var(--font-ui); text-wrap: balance; margin-top: 1.8em; scroll-margin-top: 24px; }
:where([data-doc]) h4 { font: 600 0.75rem / 1.3 var(--font-ui); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-top: 1.6em; }
:where([data-doc]) :where(h2, h3, h4) + * { margin-top: 0.6em; }

:where([data-doc]) :where(code, kbd) { font: 0.86em var(--font-mono); background: var(--panel-2); border-radius: 4px; padding: 0.1em 0.35em; }
:where([data-doc]) pre { font: 0.82rem / 1.55 var(--font-mono); background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md, 10px); padding: 14px 16px; overflow-x: auto; }
:where([data-doc]) pre code { background: none; padding: 0; font-size: inherit; }

/* A quote pulled out of the text, set larger, with a rule at its edge. */
:where([data-doc]) blockquote { margin-inline: 0; padding-left: 1.1em; border-left: 2px solid var(--line-strong, var(--line)); color: var(--muted); }
:where([data-doc]) blockquote.pull { grid-column: wide; border: 0; padding: 0.4em 0; margin-block: 1.6em; font: 400 italic clamp(1.4rem, 1.1rem + 1.2vw, 1.9rem) / 1.3 var(--font-body); color: var(--text); text-wrap: balance; }
:where([data-doc]) blockquote.pull::before { content: ""; display: block; width: 48px; height: 1px; background: var(--line-strong, var(--line)); margin-bottom: 0.6em; }
:where([data-doc]) blockquote.pull cite { display: block; margin-top: 0.6em; font: normal 400 0.875rem / 1.4 var(--font-ui); color: var(--muted); }

/* A set-apart note: what the reader should not miss, in KOS's quiet box (a tint at 8%, its edge at 25%). */
:where([data-doc]) aside.callout { --callout: var(--accent); background: color-mix(in srgb, var(--callout) 8%, transparent); border: 1px solid color-mix(in srgb, var(--callout) 25%, transparent); border-radius: var(--r-md, 10px); padding: 12px 14px; font: 400 0.9375rem / 1.55 var(--font-ui); }
:where([data-doc]) aside.callout > :first-child { margin-top: 0; }
:where([data-doc]) aside.callout.warn { --callout: var(--warn); }
:where([data-doc]) aside.callout.ok { --callout: var(--ok); }

/* Figures, numbered as they come. */
:where([data-doc]) figure { margin-inline: 0; display: flex; flex-direction: column; gap: 10px; }
:where([data-doc]) figure :where(img, svg, canvas) { max-width: 100%; height: auto; display: block; }
:where([data-doc]) figcaption { font: 400 0.8125rem / 1.45 var(--font-ui); color: var(--muted); }
:where([data-doc]) figcaption::before { counter-increment: kos-figure; content: "Figure " counter(kos-figure) ". "; font-weight: 600; color: var(--text); }
:where([data-doc]) figure.unnumbered figcaption::before { content: none; }

/* Tables: figures line up, the wrapper scrolls, the page never does. */
.doc-table { overflow-x: auto; max-width: 100%; }
:where([data-doc]) table { width: 100%; border-collapse: collapse; font: 400 0.875rem / 1.45 var(--font-ui); font-variant-numeric: tabular-nums lining-nums; }
:where([data-doc]) th { text-align: left; font-weight: 600; font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line-strong, var(--line)); padding: 8px 12px 8px 0; }
:where([data-doc]) td { border-bottom: 1px solid var(--line); padding: 8px 12px 8px 0; vertical-align: top; }
:where([data-doc]) :where(td, th).num { text-align: right; }
:where([data-doc]) tfoot td { font-weight: 600; border-bottom: 0; border-top: 1px solid var(--line-strong, var(--line)); }
:where([data-doc]) caption { caption-side: bottom; text-align: left; padding-top: 8px; font-size: 0.8125rem; color: var(--muted); }

/* Footnotes: the inline text hides, a number stands in, the note goes to the end. */
:where([data-doc]) .fn { display: none; }
.fn-ref { all: unset; cursor: pointer; font: 600 0.68em / 0 var(--font-ui); color: var(--accent); vertical-align: super; padding: 0 0.12em; border-radius: 3px; }
.fn-ref:focus-visible, .fn-back:focus-visible, .doc-toc button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.doc-notes { margin-top: 56px; font: 400 0.875rem / 1.55 var(--font-ui); color: var(--muted); }
.doc-notes > h2 { font: 600 0.75rem / 1.2 var(--font-ui); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); padding-top: 20px; border-top: 1px solid var(--line); margin: 0 0 12px; }
.doc-notes > ol { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 8px; }
.doc-notes li { scroll-margin-top: 24px; }
.doc-notes li::marker { font-variant-numeric: tabular-nums; color: var(--text); }
.fn-back { all: unset; cursor: pointer; color: var(--accent); margin-left: 6px; font-size: 0.9em; }
.flash { animation: kos-flash 1.4s ease-out; }
@keyframes kos-flash { from { background: color-mix(in srgb, var(--accent) 22%, transparent); } to { background: transparent; } }

/* The contents: beside the text when there is room, folded above it when not. */
.doc-toc { font: 400 0.8125rem / 1.4 var(--font-ui); padding-inline: var(--doc-gutter); min-width: 0; }
.doc-toc > details { border: 1px solid var(--line); border-radius: var(--r-md, 10px); padding: 10px 14px; max-width: calc(var(--doc-measure) + 2rem); margin-inline: auto; background: var(--panel); }
.doc-toc summary { cursor: pointer; font-weight: 600; font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.doc-toc ol { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.doc-toc li.sub { padding-left: 12px; }
.doc-toc button { all: unset; cursor: pointer; display: block; padding: 4px 8px; border-radius: 6px; color: var(--muted); text-wrap: pretty; }
.doc-toc button:hover { color: var(--text); background: var(--panel-2); }
.doc-toc button[aria-current="true"] { color: var(--text); background: var(--panel-2); }
@media (min-width: 1100px) {
  .doc-toc { position: sticky; top: 24px; align-self: start; max-height: calc(100vh - 48px); overflow-y: auto; padding: 0 0 0 var(--doc-gutter); }
  .doc-toc > details { border: 0; background: none; padding: 0; margin: 0; }
  .doc-toc summary { list-style: none; pointer-events: none; }
  .doc-toc summary::-webkit-details-marker { display: none; }
}

/* Editing in place. */
[data-doc][contenteditable="true"] { outline: none; caret-color: var(--accent); }
[data-doc][contenteditable="true"] > * { box-shadow: -14px 0 0 -12px transparent; }
[data-doc][contenteditable="true"] > :focus-within { box-shadow: -14px 0 0 -12px var(--line-strong, var(--line)); }
[data-doc][contenteditable="true"] .fn { display: inline; font: 400 0.8em var(--font-ui); color: var(--muted); background: var(--panel-2); border-radius: 4px; padding: 0 0.3em; }
[data-doc][contenteditable="true"] .fn::before { content: "note: "; }
/* The editor's own: the bar of formats over a selection, the "/" menu, checklists. They float, so they cast the one shadow. */
.doc-format, .doc-slash { position: absolute; z-index: 6; background: var(--panel); border: 1px solid var(--line-strong, var(--line)); border-radius: var(--r-md, 10px); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22); font: 500 0.8125rem / 1 var(--font-ui); color: var(--text); }
.doc-format { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px; max-width: min(420px, calc(100vw - 16px)); }
.doc-format[hidden], .doc-slash[hidden], .doc-format-links[hidden] { display: none; }
.doc-format > button { all: unset; cursor: pointer; min-width: 28px; height: 28px; padding: 0 6px; box-sizing: border-box; display: inline-grid; place-items: center; border-radius: 6px; color: var(--muted); }
.doc-format > button:hover { background: var(--panel-2); color: var(--text); }
.doc-format > button[data-format="bold"] { font-weight: 700; }
.doc-format > button[data-format="italic"] { font-style: italic; font-family: var(--font-body); }
.doc-format > button[data-format="code"] { font-family: var(--font-mono); font-size: 0.75rem; }
.doc-format-links { flex-basis: 100%; display: flex; flex-direction: column; gap: 1px; padding: 4px 0 0; margin-top: 2px; border-top: 1px solid var(--line); max-height: 200px; overflow-y: auto; }
.doc-format-links button { all: unset; cursor: pointer; padding: 6px 8px; border-radius: 6px; color: var(--text); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-format-links button:hover { background: var(--panel-2); }
.doc-format-links span { padding: 6px 8px; color: var(--muted); font-weight: 400; }
.doc-slash { width: 240px; max-height: 320px; overflow-y: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px; }
.doc-slash button { all: unset; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; font-weight: 400; }
.doc-slash button[aria-selected="true"], .doc-slash button:hover { background: var(--panel-2); }
.doc-slash kbd { font: 400 0.75rem / 1 var(--font-mono); color: var(--muted); }
.doc-slash-none { margin: 0; padding: 8px 10px; color: var(--muted); font-weight: 400; }
:where([data-doc]) ul.checklist { list-style: none; padding-left: 0; }
:where([data-doc]) ul.checklist > li { position: relative; padding-left: 28px; }
:where([data-doc]) ul.checklist > li::before { content: ""; position: absolute; left: 2px; top: 0.3em; width: 15px; height: 15px; box-sizing: border-box; border: 1.5px solid var(--line-strong, var(--muted)); border-radius: 4px; }
:where([data-doc]) ul.checklist > li[data-checked="true"] { color: var(--muted); text-decoration: line-through; }
:where([data-doc]) ul.checklist > li[data-checked="true"]::before { background: var(--accent); border-color: var(--accent); }
[data-editing] [data-doc] ul.checklist > li::before { cursor: pointer; }
@media print { .doc-toc { display: none; } }
@media (prefers-reduced-motion: reduce) { .flash { animation: none; } html { scroll-behavior: auto; } }
`;
