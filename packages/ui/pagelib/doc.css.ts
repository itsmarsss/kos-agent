/**
 * kos-doc's defaults: a reading measure, a modular scale (1.25 on an 18 px
 * body), and the document's furniture, on KOS's ground. The running text is
 * a reading serif; the title, headings, labels and tables are KOS's own face,
 * so a doc reads as part of the dashboard. Every selector is wrapped in
 * :where() or kept to one class, and the sheet sits before the agent's own
 * CSS, so the artifact restyles anything without fighting it. Colours are
 * KOS's tokens. The dashboard's column gives the doc its gutter; full screen
 * (data-present), or on a ground of its own (data-ground="own"), it takes its own.
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
:where(html[data-present], html[data-ground="own"]) { --doc-gutter: clamp(16px, 4vw, 40px); }
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
:where([data-doc]) > :where(p, ul, ol, dl, pre, figure, blockquote, aside, details, .doc-table, hr) { margin-top: 1.1em; }
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

/* To-dos: a box to tick before each item, the runtime's own button; a done one is struck through. */
:where([data-doc]) ul.checklist { list-style: none; padding-left: 0; }
:where([data-doc]) ul.checklist > li { position: relative; padding-left: 30px; }
:where([data-doc]) ul.checklist ul.checklist { margin-top: 0.35em; }
.todo-box { all: unset; position: absolute; left: 2px; top: calc((1lh - 16px) / 2); width: 16px; height: 16px; box-sizing: border-box; border: 1.5px solid var(--line-strong, var(--muted)); border-radius: 4px; cursor: pointer; background: var(--bg) no-repeat center / 12px 12px; transition: background-color 140ms, border-color 140ms; }
.todo-box:hover { border-color: var(--accent); }
.todo-box:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.todo-box[disabled] { cursor: default; }
.todo-box[aria-checked="true"] { background-color: var(--accent); border-color: var(--accent); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5'/%3E%3C/svg%3E"); }
:where([data-doc]) ul.checklist > li[data-checked="true"] { color: var(--muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent); }
:where([data-doc]) ul.checklist > li[data-checked="true"] > :where(ul, ol) { text-decoration: none; color: var(--text); }

/* Toggles: a line that opens to what is under it, its arrow turning as it does. */

:where([data-doc]) details > summary { list-style: none; cursor: pointer; position: relative; padding-left: 26px; font-weight: 500; }
:where([data-doc]) details > summary::-webkit-details-marker { display: none; }
:where([data-doc]) details > summary::before { content: ""; position: absolute; left: 4px; top: calc((1lh - 16px) / 2); width: 16px; height: 16px; border-radius: 4px; background: var(--muted); -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M9 6l7 6-7 6z'/%3E%3C/svg%3E") center / 14px 14px no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M9 6l7 6-7 6z'/%3E%3C/svg%3E") center / 14px 14px no-repeat; transition: transform 160ms ease; }
:where([data-doc]) details[open] > summary::before { transform: rotate(90deg); }
:where([data-doc]) details > summary:hover::before { background: var(--text); }
:where([data-doc]) details > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
:where([data-doc]) details > :not(summary) { margin-left: 26px; }
:where([data-doc]) details > summary + * { margin-top: 0.5em; }

/* A callout's mark, drawn from its colour: an i for a note, ! for a risk, a tick for what is settled. */
:where([data-doc]) aside.callout { position: relative; padding-left: 44px; }
:where([data-doc]) aside.callout::before { content: ""; position: absolute; left: 14px; top: 14px; width: 18px; height: 18px; background: var(--callout); -webkit-mask: var(--callout-mark) center / contain no-repeat; mask: var(--callout-mark) center / contain no-repeat; }
:where([data-doc]) aside.callout { --callout-mark: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 11v5M12 7.5h.01'/%3E%3C/svg%3E"); }
:where([data-doc]) aside.callout:where(.warn, .danger) { --callout-mark: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 3.5l9.5 16.5h-19z'/%3E%3Cpath d='M12 10v4.5M12 17.2h.01'/%3E%3C/svg%3E"); }
:where([data-doc]) aside.callout.ok { --callout-mark: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M8 12.5l2.7 2.7L16 9.5'/%3E%3C/svg%3E"); }
:where([data-doc]) aside.callout.danger { --callout: var(--danger); }
:where([data-doc]) aside.callout.note { --callout: var(--muted); }

/* A mention of another artifact: a chip that opens it. */
:where([data-doc]) .mention { display: inline-flex; align-items: baseline; gap: 0.3em; padding: 0 0.4em; border-radius: 5px; background: var(--panel-2); color: var(--text); font: 500 0.9em / 1.5 var(--font-ui); cursor: pointer; white-space: nowrap; text-decoration: none; transition: background-color 140ms; }
:where([data-doc]) .mention::before { content: ""; align-self: center; width: 0.95em; height: 0.95em; background: var(--muted); -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'/%3E%3Cpath d='M14 3v5h5M9 13h6M9 17h4'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'/%3E%3Cpath d='M14 3v5h5M9 13h6M9 17h4'/%3E%3C/svg%3E") center / contain no-repeat; }
:where([data-doc]) .mention:hover { background: color-mix(in srgb, var(--accent) 14%, var(--panel-2)); }
:where([data-doc]) .mention:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* Words in a colour, and highlights: KOS's tokens, at a tint for a highlight. */
:where([data-doc]) .tc-muted { color: var(--muted); }
:where([data-doc]) .tc-accent { color: var(--accent); }
:where([data-doc]) .tc-ok { color: var(--ok); }
:where([data-doc]) .tc-warn { color: color-mix(in srgb, var(--warn) 80%, var(--text)); }
:where([data-doc]) .tc-danger { color: var(--danger); }
:where([data-doc]) mark { --hl: var(--warn); background: color-mix(in srgb, var(--hl) 26%, transparent); color: inherit; border-radius: 3px; padding: 0 0.1em; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
:where([data-doc]) mark.hl-muted { --hl: var(--muted); }
:where([data-doc]) mark.hl-accent { --hl: var(--accent); }
:where([data-doc]) mark.hl-ok { --hl: var(--ok); }
:where([data-doc]) mark.hl-danger { --hl: var(--danger); }
:where([data-doc]) :where(s, del) { text-decoration-color: color-mix(in srgb, currentColor 60%, transparent); }

/* Editing in place: the text as it reads, with room at its left for each block's handle. */
[data-doc][contenteditable="true"] { outline: none; caret-color: var(--accent); }
[data-doc][contenteditable="true"] .fn { display: inline; font: 400 0.8em var(--font-ui); color: var(--muted); background: var(--panel-2); border-radius: 4px; padding: 0 0.3em; }
[data-doc][contenteditable="true"] .fn::before { content: "note: "; }
[data-doc][contenteditable="true"] details > summary { cursor: text; }
[data-doc][contenteditable="true"] details > summary::before { cursor: pointer; }
[data-doc][contenteditable="true"] .mention { cursor: default; }
[data-doc][contenteditable="true"] ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
/* The empty line's hint, which takes no room and no caret. */
[data-kos-ph]::before { content: attr(data-kos-ph); float: left; height: 0; pointer-events: none; color: var(--faint, var(--muted)); font-style: normal; font-weight: inherit; }
ul.checklist > li[data-kos-ph]::before { margin-left: 0; }
html.doc-dragging, html.doc-dragging * { cursor: grabbing !important; user-select: none; }

/* The editor's own, outside the article. What floats casts the one shadow. */
.doc-format, .doc-menu, .doc-tabletools { position: absolute; z-index: 6; background: var(--panel); border: 1px solid var(--line-strong, var(--line)); border-radius: var(--r-md, 10px); box-shadow: var(--float, 0 12px 32px rgba(0, 0, 0, 0.45)); font: 500 0.8125rem / 1.25 var(--font-ui); color: var(--text); }
.doc-format[hidden], .doc-menu[hidden], .doc-handle[hidden], .doc-drop[hidden], .doc-codetools[hidden], .doc-tabletools[hidden] { display: none; }
.doc-format { display: flex; align-items: center; gap: 1px; padding: 3px; }
.doc-format > button { all: unset; cursor: pointer; min-width: 30px; height: 30px; padding: 0 7px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 7px; color: var(--muted); font-size: 0.875rem; transition: background-color 140ms, color 140ms; }
.doc-format > button:hover, .doc-format > button:focus-visible { background: var(--panel-2); color: var(--text); }
.doc-format > button[data-format="turn"] { color: var(--text); font-size: 0.8125rem; padding-right: 10px; margin-right: 3px; border-right: 1px solid var(--line); border-radius: 7px 0 0 7px; }
.doc-format > button[data-format="bold"] { font-weight: 700; }
.doc-format > button[data-format="italic"] { font-style: italic; font-family: var(--font-body); font-size: 1rem; }
.doc-format > button[data-format="underline"] { text-decoration: underline; text-underline-offset: 3px; }
.doc-format > button[data-format="strike"] { text-decoration: line-through; }

.doc-menu { width: 264px; max-height: min(360px, 70vh); overflow-y: auto; padding: 3px; display: flex; flex-direction: column; gap: 1px; overscroll-behavior: contain; }
.doc-menu.doc-colours { width: 196px; max-height: none; }
.doc-menu.doc-colours > button { min-height: 28px; padding-block: 2px; }
.doc-menu.doc-colours .doc-menu-group { padding-block: 6px 3px; }
.doc-menu > button { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 4px 8px; border-radius: 7px; font-weight: 400; color: var(--text); }
.doc-menu > button.on { background: var(--panel-2); }
.doc-menu > button:focus-visible { outline: none; background: var(--panel-2); }
.doc-menu > button.danger { color: var(--danger); }
.doc-menu-icon { flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; color: var(--muted); }
.doc-slash { gap: 2px; }
.doc-slash > button { min-height: 46px; padding: 5px 8px; gap: 12px; }
.doc-slash .doc-menu-icon { width: 34px; height: 34px; border-radius: 6px; background: var(--bg); border: 1px solid var(--line); color: var(--text); }
.doc-menu > button.danger .doc-menu-icon { color: var(--danger); }
.doc-menu-words { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.doc-menu-words > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-menu-words > small { font-size: 0.75rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-menu kbd { font: 400 0.75rem / 1 var(--font-mono); color: var(--muted); }
.doc-menu-more { display: inline-grid; color: var(--muted); }
.doc-menu-swatch { flex: none; width: 18px; height: 18px; border-radius: 5px; background: var(--swatch); border: 1px solid var(--line); box-sizing: border-box; }
.doc-menu-group { margin: 0; padding: 8px 8px 4px; font: 600 0.6875rem / 1 var(--font-ui); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.doc-menu-group:not(:first-child) { margin-top: 4px; border-top: 1px solid var(--line); padding-top: 10px; }
.doc-menu-none { margin: 0; padding: 8px 10px; color: var(--muted); font-weight: 400; }

/* The handle beside a block: "+" to add below, the grip to drag or open its menu. */
.doc-handle { position: absolute; z-index: 5; display: flex; align-items: center; gap: 0; height: 24px; }
.doc-handle > button { all: unset; box-sizing: border-box; width: 22px; height: 24px; display: inline-grid; place-items: center; border-radius: 5px; color: var(--faint, var(--muted)); cursor: pointer; transition: background-color 140ms, color 140ms; }
.doc-handle > button:hover, .doc-handle > button:focus-visible { background: var(--panel-2); color: var(--text); }
.doc-handle > .doc-grip { cursor: grab; width: 18px; }
.doc-handle > button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.doc-drop { position: absolute; z-index: 5; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 70%, transparent); pointer-events: none; }
.doc-picks { position: absolute; inset: 0 auto auto 0; pointer-events: none; z-index: 1; }
.doc-pick { position: absolute; border-radius: 6px; background: color-mix(in srgb, var(--accent) 13%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }

/* A code block's language, and a table's rows and columns, beside the caret. */
.doc-codetools { position: absolute; z-index: 4; }
.doc-codelang { all: unset; cursor: pointer; font: 500 0.75rem / 1 var(--font-ui); color: var(--muted); padding: 5px 8px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--line); }
.doc-codelang:hover, .doc-codelang:focus-visible { color: var(--text); }
.doc-tabletools { display: flex; gap: 1px; padding: 3px; }
.doc-tabletools > button { all: unset; box-sizing: border-box; cursor: pointer; width: 28px; height: 28px; display: inline-grid; place-items: center; border-radius: 7px; color: var(--muted); }
.doc-tabletools > button:hover, .doc-tabletools > button:focus-visible { background: var(--panel-2); color: var(--text); }
.doc-tabletools > button.danger:hover { color: var(--danger); }
.doc-live, .doc-copier { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; opacity: 0; left: -9999px; }
/* On paper: white under the text, no contents to press, a heading kept with what follows it, and a figure, table, quote or code block whole on its page where it fits. */
@media print {
  @page { size: letter; margin: 0.75in 0.8in; }
  .doc-toc, .fn-back, .doc-handle, .doc-format, .doc-menu { display: none; }
  .todo-box { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  :where(html[data-kind="doc"]) body { background: var(--panel); }
  :where([data-doc], .doc-notes) :where(h1, h2, h3, h4) { break-after: avoid; break-inside: avoid; }
  :where([data-doc]) :where(figure, table, pre, blockquote, aside, .doc-table, img, svg) { break-inside: avoid; }
  :where([data-doc], .doc-notes) :where(p, li) { orphans: 3; widows: 3; }
  /* The same ink without opacity, which a PDF paints as a group of its own after the rest, so the lede read out of order. */
  :where([data-doc]) .lede { opacity: 1; color: color-mix(in srgb, var(--text) 86%, var(--panel)); }
}
@media (prefers-reduced-motion: reduce) { .flash { animation: none; } html { scroll-behavior: auto; } .todo-box, :where([data-doc]) details > summary::before { transition: none; } }
`;
