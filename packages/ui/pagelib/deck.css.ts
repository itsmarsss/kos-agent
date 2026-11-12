/**
 * kos-deck's defaults. A slide is a 16:9 box sized to the frame, and every
 * size inside it is in cqw (a hundredth of the slide's width), so a slide
 * reads the same full screen, in the frame, and as a thumbnail in the grid,
 * with no scaling by script. On a phone held upright the slides stack and
 * their type keeps a readable floor. A slide is KOS's panel with a 1 px
 * line on KOS's ground, its type KOS's face, and every slide, the title one
 * too, follows the theme. Selectors sit in :where() or one class, before the
 * agent's own CSS, so the artifact restyles anything.
 */
export const DECK_CSS = String.raw`
:where(:root) {
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-display: var(--font-ui);
  --font-body: var(--font-ui);
  --font-mono: var(--mono, ui-monospace, Menlo, monospace);
  --deck-title: 6.4cqw;
  --deck-heading: 3.9cqw;
  --deck-body: 2.25cqw;
  --deck-small: 1.55cqw;
  --deck-pad: 6cqw;
  --deck-gap: 2.4cqw;
  --deck-bar: 52px;
  --deck-notes-h: 0px;
  --deck-stage-pad: 12px;
}
:where(html[data-kind="deck"]) body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--font-body); overflow: hidden; height: 100dvh; }

/* The stage: the current slide, centred, as large as the frame allows. Each slide sits in a
   frame of KOS's (.deck-slide) that is its size container, so the slide's own padding and
   type are in units of its own width too. */
:where([data-deck]) { height: calc(100dvh - var(--deck-bar) - var(--deck-notes-h)); display: grid; place-items: center; padding: var(--deck-stage-pad); box-sizing: border-box; min-width: 0; }
.deck-slide {
  container-type: inline-size;
  position: relative;
  box-sizing: border-box;
  width: min(100%, calc((100dvh - var(--deck-bar) - var(--deck-notes-h) - 2 * var(--deck-stage-pad)) * 16 / 9));
  aspect-ratio: 16 / 9;
  border-radius: var(--r-md, 10px);
  overflow: hidden;
  box-shadow: 0 0 0 1px var(--line);
}
/* Only the current slide shows, whatever display the artifact gives its slides; on paper, every one. */
@media screen { body:not(.deck-grid):not(.deck-read) .deck-slide:not(.current) { display: none !important; } }
:where(.deck-slide) > section {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--deck-gap);
  padding: var(--deck-pad);
  background: var(--slide-bg, var(--panel));
  color: var(--slide-ink, var(--text));
  font-size: var(--deck-body);
  line-height: 1.35;
}
:where(.deck-slide) > section > * { margin: 0; min-width: 0; }

/* Type, all in slide units. */
:where([data-deck]) h1 { font: 700 var(--deck-title) / 1.05 var(--font-display); letter-spacing: -0.025em; text-wrap: balance; }
:where([data-deck]) h2 { font: 600 var(--deck-heading) / 1.12 var(--font-display); letter-spacing: -0.02em; text-wrap: balance; }
:where([data-deck]) h3 { font: 600 calc(var(--deck-body) * 1.05) / 1.25 var(--font-ui); }
:where([data-deck]) :where(p, li, td, th, dd, dt) { font-size: var(--deck-body); text-wrap: pretty; }
:where([data-deck]) :where(ul, ol) { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: calc(var(--deck-gap) * 0.5); }
:where([data-deck]) li::marker { color: var(--accent); }
:where([data-deck]) :where(small, .muted, figcaption) { font-size: var(--deck-small); color: var(--muted); }
:where([data-deck]) .kicker { font: 600 var(--deck-small) / 1.2 var(--font-ui); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
:where([data-deck]) :where(code, .mono) { font-family: var(--font-mono); font-size: 0.9em; }
:where([data-deck]) table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
:where([data-deck]) :where(th, td) { text-align: left; padding: 0.5cqw 1.2cqw 0.5cqw 0; border-bottom: 1px solid var(--line); }
:where([data-deck]) th { font-size: var(--deck-small); color: var(--muted); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
:where([data-deck]) :where(td, th).num { text-align: right; }
:where([data-deck]) :where(img, svg, canvas) { max-width: 100%; max-height: 100%; display: block; }
:where([data-deck]) figure { margin: 0; display: flex; flex-direction: column; gap: 1cqw; min-height: 0; }

/* The slide shapes. */
:where(.deck-slide) > section.title { justify-content: flex-end; gap: calc(var(--deck-gap) * 0.8); }
:where(.deck-slide) > section.title h1 { max-width: 18ch; }
:where(.deck-slide) > section.title :where(p:not(.kicker)) { font-size: calc(var(--deck-body) * 1.15); color: var(--muted); max-width: 46ch; }
:where(.deck-slide) > section.statement { justify-content: center; }
:where(.deck-slide) > section.statement :where(p, h2, blockquote) { font: 600 calc(var(--deck-heading) * 1.18) / 1.15 var(--font-display); letter-spacing: -0.015em; max-width: 24ch; text-wrap: balance; margin: 0; }
:where(.deck-slide) > section.split { display: grid; grid-template-columns: 1fr 1fr; align-items: center; column-gap: calc(var(--deck-pad) * 0.75); }
:where(.deck-slide) > section.closing { justify-content: center; align-items: flex-start; }
:where(.deck-slide) > section.closing h2 { font-size: calc(var(--deck-title) * 0.85); }
:where(.deck-slide) > section.bleed { padding: 0; }
:where([data-deck]) .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); grid-auto-flow: column; gap: calc(var(--deck-gap) * 1.2); align-items: start; }
:where([data-deck]) .big { font: 700 calc(var(--deck-title) * 1.6) / 0.95 var(--font-display); letter-spacing: -0.03em; font-variant-numeric: tabular-nums lining-nums; }
:where([data-deck]) aside.notes { display: none !important; }

/* Controls. */
.deck-bar { position: fixed; inset: auto 0 0 0; height: var(--deck-bar); display: flex; align-items: center; gap: 6px; padding: 0 12px; box-sizing: border-box; font: 500 13px / 1 var(--font-ui); color: var(--muted); border-top: 1px solid var(--line); background: var(--panel); z-index: 3; }
.deck-bar button { font: inherit; display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
.deck-bar button:hover { border-color: var(--line-strong, var(--line)); background: var(--panel-2); }
.deck-bar button[aria-pressed="true"] { background: var(--panel-2); border-color: var(--line-strong, var(--line)); }
.deck-bar button:disabled { opacity: 0.4; cursor: default; }
.deck-bar button:focus-visible, .deck-slide:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.deck-bar .deck-count { font-variant-numeric: tabular-nums; min-width: 6ch; text-align: center; color: var(--text); }
.deck-bar .deck-spacer { flex: 1; }
/* A narrow frame (a phone's column): the bar's buttons tighten so Present stays in reach, and the bar scrolls sideways before anything is cut. */
@media (max-width: 480px) {
  .deck-bar { gap: 4px; padding: 0 8px; overflow-x: auto; scrollbar-width: none; }
  .deck-bar::-webkit-scrollbar { display: none; }
  .deck-bar button { padding: 0 9px; min-height: 30px; flex: none; }
  .deck-bar .deck-count { min-width: 4ch; }
}
.deck-notes { position: fixed; inset: auto 0 var(--deck-bar) 0; height: var(--deck-notes-h); overflow-y: auto; box-sizing: border-box; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--panel); font: 400 15px / 1.5 var(--font-ui); color: var(--text); z-index: 2; }
.deck-notes .deck-notes-label { display: block; font: 600 11px / 1 var(--font-ui); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.deck-notes .deck-notes-none { color: var(--muted); }
body.deck-notes-on { --deck-notes-h: min(30dvh, 200px); }
body:not(.deck-notes-on) .deck-notes { display: none; }

/* Held by the dashboard: its bar and its notes are the viewer's, and the slide is the whole frame,
   which the dashboard sizes to it, so no ground of the deck's shows around it. */
body.deck-hosted, body.deck-hosted.deck-notes-on { --deck-bar: 0px; --deck-notes-h: 0px; --deck-stage-pad: 0px; }
body.deck-hosted .deck-bar, body.deck-hosted .deck-notes { display: none; }
body.deck-hosted:not(.deck-grid) .deck-slide { border-radius: 0; box-shadow: none; }

/* The grid of every slide: the same slides, smaller, since their sizes are relative. */
body.deck-grid { overflow-y: auto; }
body.deck-grid :where([data-deck]) { height: auto; min-height: calc(100dvh - var(--deck-bar)); display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 18px; align-content: start; place-items: stretch; padding: 20px 20px calc(var(--deck-bar) + 20px); }
body.deck-grid .deck-slide { width: 100%; cursor: pointer; }
body.deck-grid .deck-slide * { pointer-events: none; }
body.deck-grid .deck-slide.current { box-shadow: 0 0 0 2px var(--accent); }
body.deck-grid .deck-slide::after { content: attr(data-number); position: absolute; left: 8px; bottom: 6px; font: 600 11px / 1 var(--font-ui); color: var(--muted); font-variant-numeric: tabular-nums; }
body.deck-grid .deck-notes { display: none; }

/* Presenting: the slide alone, on black, edge to edge. */
body.deck-present { --deck-bar: 0px; --deck-notes-h: 0px; background: #000; cursor: none; }
body.deck-present .deck-bar, body.deck-present .deck-notes { display: none; }
body.deck-present :where([data-deck]) { padding: 0; height: 100dvh; }
body.deck-present .deck-slide { width: min(100vw, calc(100dvh * 16 / 9)); border-radius: 0; box-shadow: none; }

/* A phone held upright: slides stack as cards and the type keeps a floor. */
body.deck-read { overflow-y: auto; height: auto; --deck-bar: 0px; }
body.deck-read .deck-bar, body.deck-read .deck-notes { display: none; }
body.deck-read :where([data-deck]) { height: auto; display: flex; flex-direction: column; gap: 14px; padding: 0 0 16px; }
body.deck-read .deck-slide { width: 100%; aspect-ratio: auto; }
body.deck-read :where(.deck-slide) > section {
  height: auto; min-height: 56cqw; padding: max(var(--deck-pad), 20px);
  --deck-title: max(6.4cqw, 30px); --deck-heading: max(3.9cqw, 23px); --deck-body: max(2.25cqw, 16px); --deck-small: max(1.55cqw, 13px); --deck-gap: max(2.4cqw, 12px);
}
body.deck-read :where(.deck-slide) > section.split { display: flex; }
body.deck-read :where([data-deck]) .cols { grid-auto-flow: row; grid-template-columns: minmax(0, 1fr); }
body.deck-read :where(.deck-slide) > section.bleed { padding: 0; }

@media (prefers-reduced-motion: no-preference) {
  body:not(.deck-grid):not(.deck-read) .deck-slide.current { animation: kos-slide-in 180ms ease-out; }
}
@keyframes kos-slide-in { from { opacity: 0.4; } to { opacity: 1; } }
/* On paper, a slide a page: each 16:9 page filled to its edges, nothing after the last. */
@media print {
  @page { size: 13.333in 7.5in; margin: 0; }
  .deck-bar, .deck-notes { display: none; }
  body { height: auto; overflow: visible; }
  :where([data-deck]) { height: auto; display: block; padding: 0; }
  .deck-slide { display: block !important; width: 100%; break-after: page; break-inside: avoid; box-shadow: none; border-radius: 0; }
  .deck-slide:last-of-type { break-after: auto; }
}
`;
