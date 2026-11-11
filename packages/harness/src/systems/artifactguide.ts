import { ARTIFACT_FONTS, KIND_FONTS, type ArtifactKind } from "@kos/shared";

/**
 * KOS's design guide for artifacts, as artifacts.guide returns it: the general
 * part every artifact needs, then the part for the kind being made. It is
 * read on demand rather than sent with every prompt, so it can be specific
 * and long enough to raise the work above a first draft.
 */

const fontList = (): string =>
  ARTIFACT_FONTS.map((f) => `- ${f.id}: ${f.family} (${f.role}), ${f.use}. Use var(--font-${f.id}).`).join("\n");

const kindDefaults = (kind: ArtifactKind): string => {
  const ids = KIND_FONTS[kind];
  return ids.length ? `Without fonts, a ${kind} gets ${ids.join(", ")}.` : `Without fonts, a ${kind} uses the system face KOS itself is set in.`;
};

/** The workflow's last steps where KOS has a Chrome to check in, and where it has none. */
const CHECK_STEPS = `4. Check it once with artifacts.check({ id }). It renders the artifact in KOS's own headless Chrome at 1280 px and 390 px wide, light and dark, and reports sideways overflow and the element causing it, text cut off by a box that hides its overflow, text drawn over other text, colours that stay the same in both themes, text below AA contrast, console errors, failed bridge calls, regions empty at rest, a missing visible title, and, marked small, the generated look (an inverted slide or band, bordered boxes wrapping sections, big figures reading 0 or a dash, a ground other than KOS's without a token plan), with a small screenshot.
5. Fix everything the check reports in one pass, write again, then finish. Do not check again in a loop; one check, one round of fixes.`;
const NO_CHECK_STEPS = `4. This KOS has no Chrome to render artifacts in, so artifacts.check is not available here; do not call it. Before writing, read the HTML over once against this guide (tokens for both themes, nothing wider than a 390 px phone, no empty regions at rest, a visible title), then write once and finish.`;

const GENERAL = `# How KOS makes an artifact

An artifact is one HTML document KOS writes for the owner: a page (an app, dashboard or tool), a doc, a deck or a sheet. All four run in the same sandboxed frame, take KOS's tokens and look by default, and reach data only through window.kos. The kind decides which runtime KOS adds beside the document and which defaults it starts from.

## Workflow

1. Read this guide for the kind you are making: artifacts.guide({ kind }).
2. Decide the treatment and the subject (below) before writing markup.
3. Write it with artifacts.write: project (omit it for a new workspace artifact, which then has no tables or files to read; rewriting an existing id without it keeps the artifact where it is), id, kind, title, description, html, and fonts, capabilities, libraries or headline when needed.
${CHECK_STEPS}

## Decide the treatment first

Before any markup, name what this is and pick one of two treatments.
- KOS's own look, the default: a plan, a memo, a report, a budget, a dashboard, a tracker, a deck for a meeting. Built on KOS's tokens and face, it sits on the dashboard as part of KOS: clear hierarchy, quiet surfaces, the content carrying it.
- Distinctive, only for a piece clearly meant to stand apart: a poster, an invitation, a brand or showcase piece, or a look the owner asked for. It writes its own token plan (below).
When unsure, it is KOS's own look.

## Ground it in the subject

Write down, for yourself, three things: the one subject, who reads it, and the single job the artifact does for them (decide, track, learn, present). Everything on it serves that job.
- Use the subject's own units and terms: kilograms and sets for a training log, CAD and categories for a budget. Name things the way the owner does.
- Use real content. Never lorem ipsum, "Item 1", "John Doe", "Lorem", "Your title here" or invented metrics. When the owner gave notes, a CSV or a project, every number and name comes from there.
- A project artifact reads its tables live through window.kos; a pasted snapshot goes stale with the next row.
- When nothing real exists yet, a tool opens with clearly marked example data ("Example rows: replace with your own") so it is in a working state, not an empty shell.

## Build on KOS's tokens

The frame sets KOS's tokens for the current theme and paints KOS's ground, so plain markup reads as KOS. Build from them; define no colours of your own.
- Colour: --bg (the ground), --panel (a surface set apart), --panel-2 (a control, a row under the pointer), --line and --line-strong (rules, borders), --text, --muted (secondary words, labels, times), --faint (decoration only: it is below AA for text), --accent (what to act on, a link, the chosen thing; never kickers, rules or decoration) with --on-accent, and --ok, --warn, --danger. A tint is color-mix(in srgb, var(--accent) 14%, transparent).
- Type: the system face, already on the body; sizes --text-xs to --text-2xl; var(--mono) for code and ids; weights 400, 500, 600 and 700 only.
- Shape: --r-sm (7 px) for a control, --r-md (10 px) for a box. Borders separate; only what floats casts a shadow.
- Leave the body's background, colour, font and padding alone: the dashboard sets the frame in its column, with its gutter, so the artifact's edges line up with its head.
- Start the first <style> with a comment saying the layout concept.

A short example, for a cycling training log:

    /* layout: a week strip on top, the ride list below, totals in a right rail from 900 px */
    .week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
    .day { padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--panel); }
    .day.today { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
    section + section { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }
    .label { font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }

## Both themes

The <html> element carries data-theme and data-mode, each "light" or "dark", from the dashboard's theme, changed live when the owner switches; kos.theme reads it and kos.onTheme(fn) hears a change. KOS's tokens carry both themes, so an artifact built on them needs nothing more. No literal colour (no #fff text, no rgba(0,0,0,.05) wash, no black shadow), and no slide, band or panel in the other theme's brightness.

## A distinctive piece: its own token plan

Only for the distinctive treatment: a plan on :root of 4 to 6 colour tokens (ground, surface, ink, muted ink, one accent, a line) and two or three font roles (--font-display, --font-body, --font-ui or --font-mono), and after it no literal colour or font family anywhere. Write each theme with this exact pattern, so the owner's toggle wins both ways:

    :root { light values }
    @media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { dark values } }
    :root[data-theme=dark] { dark values }

The body takes its background and colour from the plan; KOS then gives it a gutter, and every box on it pads its own edges. Design the dark theme rather than invert: lifted greys, not pure black, a lighter accent, subtler lines.

## Fonts

KOS's own look needs no fonts: it is the system face, and a doc brings its reading serif. A distinctive piece names the bundled ones it uses in artifacts.write's fonts (ids below); KOS inlines them as var(--font-<id>), with a fallback stack.
${fontList()}

Pair deliberately: a serif body with a grotesque for labels, or one sans in two weights with a mono for figures; two families usual, three the most, a display face at one or two sizes.

## Typography

- Running text near 65 characters a line, line-height 1.5 to 1.65 for body, 1.1 to 1.25 for headings.
- One type scale and nothing between: KOS's --text-xs to --text-2xl, or a distinctive piece's 5 or 6 steps.
- One h1 with at most a line of context under it, set once.
- text-wrap: balance on headings, text-wrap: pretty on paragraphs.
- Uppercase labels are small, letter-spaced (0.06em to 0.1em) and in the muted ink.
- Numbers that line up use font-variant-numeric: tabular-nums, right-aligned in tables.
- A range of figures (an en dash between them, never a hyphen), a date range or a figure with its unit stays on one line: wrap it in <span class="nowrap">.

## Layout

- Lay out with flex or grid and gap, not margins between siblings.
- No side gutter or body padding of your own: the dashboard's column gives the frame its gutter. Space inside the artifact (between sections, inside a box) is yours.
- One column at about 400 px. Every artifact must work at 390 px wide: let grids wrap (repeat(auto-fit, minmax(min(240px, 100%), 1fr))), no fixed widths.
- Give text children of flex and grid items min-width: 0 so long words and numbers do not push the layout.
- overflow-x: auto only on tables, code and diagrams, inside their own wrapper. The body never scrolls sideways.
- Never hide overflow to make something fit: it cuts a label off the moment its box is narrower than its words, as on a phone. A row of figures goes to two columns, then one, first.
- Repeated elements share edges, baselines and padding.
- Sections, not cards: a heading, space and a 1 px rule (border-top: 1px solid var(--line)) set a section apart. A card (panel fill, 1 px line, radius 10) is for a discrete object the owner compares or acts on, a book or a ride; never one around every section, never one in another.
- Big figures only when the numbers are the point, and only with real values: a figure reading 0, a dash or "n/a" at rest is noise, so leave it out or say what is missing. Figures sit in a row on the ground between two rules, not each in its own box.

## Charts

Draw them to scale from zero unless the subject says otherwise, with axis labels only at values the chart reaches. A bar drawn in HTML is the kit's <div class="meter" style="--value: 42%">, or a fill that is a block (a div) given width as a percentage; an inline span ignores its width and draws nothing. Colour series from tokens, leave room for labels, and label directly rather than with a legend when there are few series. Use SVG or the charts library, never a canvas with no text alternative.

## Complete at rest

Everything is readable on first paint. No reveal-on-scroll, no fade-in that hides content until an observer fires, no section waiting on a click to show its point. Motion, if any, is short and respects prefers-reduced-motion. A tool opens in a realistic working state: the current week selected, the latest rows shown, a sensible default filter.

## Avoid the generated look

These read as made by a machine, so do not reach for them by default:
- a palette of its own on a working document, a slab of another colour on the dashboard;
- cream paper with a serif and a terracotta accent;
- near-black with one acid green or electric accent;
- a purple-to-blue gradient hero;
- Inter or Space Grotesk because nothing was chosen;
- an inverted title slide or band: a dark slab on a light page, a light one on a dark page;
- a row of figure tiles reading 0, a dash or a placeholder;
- a card around every section, cards inside cards, or rounded cards with soft shadows around every block;
- duplicate headers: a title bar or header card over the h1, a heading that says the h1 again, a line that repeats the description;
- the accent on everything: kickers, rules, icons and borders all in it, so nothing stands out;
- emoji as section markers or bullets;
- everything centred;
- 01 / 02 / 03 markers on content that is not a sequence;
- many queries at once, one per figure: ask for what a view needs in one query (GROUP BY, a CTE) and keep a page to a handful.
When the owner gives a direction (a colour, a face, a reference, a mood), follow it over this list.

## Copy

- Active voice, plain sentences, no mannered devices (no "not just X, but Y", no rhetorical questions as headings, no triplets for rhythm).
- Name controls by what they do: "Add ride", "Export week", not "Submit" or "Go".
- Errors say what went wrong and how to fix it.
- Empty states say what will be there and how to start it.

## Naming

The title is a short specific noun phrase, a name and not a caption: "Halifax Rent Budget", "Q4 Hiring Plan", "Thesis Defence Deck". Not "A dashboard showing my budget". The description is one separate sentence saying what it is for. The title also appears as the visible h1 (or the title slide).

## Interfaces

- Summary before detail: the figure or status that answers the main question first, the rows after.
- Show state in form: a pill for a status, chips for filters, a tag for a category, not a sentence.
- Keep semantic colours (ok, warn, danger) apart from the accent; the accent means "act here", not "good".
- Interactive things look interactive: buttons look like buttons, rows that open show a hover and a cursor.

## Build cleanly

- Visible focus on everything that takes it (:focus-visible with an outline from a token).
- @media (prefers-reduced-motion: reduce) turns motion off.
- No overlapping elements at any width; no absolutely positioned text over content.
- No cascade fights: low specificity, no !important, one rule per thing. The frame already styles plain markup and the kit classes (.grid .row .stack .stat .btn .pill .tag .label .hint .empty .table-wrap, .card for a discrete object, and .tile, which is a small fixed square); use them as they are, and never take one of those names for something else of your own.

## What the frame refuses

The frame has no network: no CDN, no fetch, no external font, image, style or script. Draw with SVG, CSS or canvas, and inline small images as data: URIs. The artifact stays where it is: no <form> (use inputs and a button), no <link>, <meta http-equiv>, <iframe>, <object> or <base>, no link targets, downloads or links off the artifact (link within it with #id), no location, open(), submit() or WebRTC. artifacts.write refuses an artifact holding any of these, and the frame stops them at run time. Write a closing script tag plainly as </script>.`;

const PAGE = `# Page: an app, dashboard or tool

A page is the general kind: anything that is not a document, a deck or a sheet. ${kindDefaults("page")} No runtime is added; the libraries are yours to name.

## Data through window.kos

Every call is a promise. A page in a project reads that project and nothing else; a workspace page has no tables or files.
- kos.query(sql, params?) returns { rows, truncated }: one read-only SELECT over this project's own tables, at most 500 rows and 2 s. Use ? placeholders for values. Name the PHYSICAL tables systems.migrate reported (they carry the project's prefix). KOS answers a page's queries a couple at a time, in order, so ask for a few that each return what a view needs rather than one per figure.
- kos.write(table, op, values, key?): op is insert, update or delete; key is { column, value } for update and delete. Only tables and columns declared in capabilities.writes: [{ table, columns, allow? }], allow being any of insert, update, delete (default insert and update).
- kos.files.read(path) returns { text }: a text file inside the project's folder, when capabilities.files is true.
- kos.ask(text): offers a message to the project's chat, which the owner confirms. Needs capabilities.ask.
- kos.theme is "light" or "dark"; kos.onTheme(fn) hears a change; kos.refresh(fn) registers what to run again after the page's own writes.

Query at load and again after each write, so the page shows what is in the tables now. Never paste the project's data into the HTML. When the owner puts data in (a log, a tracker), give the page inputs and a button whose click calls kos.write, and declare the table in capabilities.writes. A refusal comes back as a sentence; show it beside the control that caused it.

## Libraries

- libraries: ["react"] gives window.React, window.ReactDOM (createRoot) and h = React.createElement. There is no build step and no JSX: write h("div", { className: "x" }, ...).
- libraries: ["charts"] gives KosCharts.bar(el, { labels, values }), KosCharts.line(el, { labels, values }) and KosCharts.pie(el, { labels, values }), drawn as SVG in the theme. Size the element; the chart follows its width. For anything the library cannot draw, write SVG yourself from your tokens.

## Headline

headline: { label, query } puts one figure on the project's card on Home: a SELECT returning one value, such as the month's spend. Pick the number the owner would ask for first.

## Shape of a good page

- The first screen answers the page's job: this month's spend against budget, today's sessions, what is overdue. Put that summary at the top, then the detail that explains it, then the controls that change it.
- The page opens with its h1 and one line of context on KOS's ground, then the summary: no header card, no banner.
- A dashboard is a few well-chosen views, not every query you could run. Three views that answer real questions beat eight tiles.
- Tables: sticky header when long, numbers right-aligned in tabular figures, the identifying column first, wide tables in .table-wrap or your own overflow wrapper.
- Forms: labels above inputs, sensible defaults (today's date, the last category used), Enter adds, and the new row appears without a reload because the page queries again after the write.
- Filters and periods as chips at the top of the view they change, with the active one obvious.
- Loading: show the layout with its labels immediately and fill numbers when the query returns; never a blank page with a spinner.
- Errors from a query or write appear next to what failed, in words the owner can act on.
- From 390 px: figures stack, tables scroll inside their wrapper, controls stay at least 40 px tall to tap.
- A page that throws shows the error with a button that asks you to fix it; read it back with artifacts.get first.`;

const DOC = `# Doc: a designed document

A doc is a report, plan, memo, brief or guide meant to be read. The kos-doc runtime sets it in a reading column and does the bookkeeping. ${kindDefaults("doc")}

## Structure

Write one <article data-doc> holding the whole document. Do not nest another <article> inside it.

    <article data-doc>
      <header>
        <p class="kicker">Project brief, November 2026</p>
        <h1>Riverside Clinic Booking Rebuild</h1>
        <p class="lede">The one or two sentences that state the point.</p>
        <p class="byline">Prepared for the clinic's operations lead</p>
      </header>
      <h2>Why now</h2>
      <p>Text with a source<span class="fn">Front desk call log, September 2026.</span>.</p>
      <figure><svg>...</svg><figcaption>Weekly bookings by channel</figcaption></figure>
    </article>

What the runtime does:
- h2 starts a section and h3 a subsection; at 4 or more h2 it builds a table of contents beside the text on wide screens and above it on narrow ones.
- <span class="fn">text</span> inline becomes a numbered note marker, and the notes are collected under Notes after the article, each with a way back.
- Each <figure> with a <figcaption> is numbered automatically ("Figure 2."); figure.unnumbered skips the number. Add class doc-wide to a figure that should run wider than the text, doc-full for the full width.
- blockquote.pull is a pull quote (a <cite> inside names the speaker); aside.callout is a set-apart note, with .warn and .ok for a risk and a settled decision.
- Tables are wrapped so they scroll sideways on their own when wide; give numeric cells class num (td.num, th.num) to align them on the right in tabular figures.
- --doc-measure sets the column width (default 66ch) and --doc-size the body size (default 1.125rem). Override them on :root rather than setting widths on paragraphs.

## Editing

The owner can edit the text in place, and each save becomes a new version of the artifact. So:
- keep text as text: headings, paragraphs and table cells, never words drawn into SVG paths or images;
- put any script outside the article, after it; the article holds content only;
- add data-locked to the article when the document should not be edited (a generated report that is rewritten from data).

## Document conventions

- The lede states the conclusion, not the topic: "Moving bookings online saves the front desk about 9 hours a week" rather than "This brief looks at booking".
- A memo or plan puts the decision or the ask at the top, in the lede or a callout, with the reasoning after it.
- Each section answers one question, and its heading says the answer or the question plainly ("What it costs", "Risks we accept").
- Paragraphs are short and carry one idea each. Lists only for items that really are parallel.
- Tables for comparisons: options against criteria, plan against actual, with units in the header, not in every cell.
- Pull quotes sparingly: one per long section at most, and only of a sentence worth reading twice.
- Figures earn their place: a chart that shows the trend the text describes, a diagram of the process, each with a caption that says what to see.
- Footnotes for sources and asides that would interrupt the sentence; not for content the reader needs.
- A one-page brief fits in roughly 400 to 700 words: the lede, three to five short sections, perhaps one table.
- End with what happens next: owners, dates, the next decision.

## Treatment

Docs take KOS's own look. The runtime sets the running text in a reading serif on KOS's ground, and the title, headings, labels and tables in KOS's face, all coloured from KOS's tokens: write no colours, fonts or background of your own. The accent is for links and the one callout that matters, not the kicker or the rules. Let the type do the work; no cards around sections, and tables with thin rules rather than boxes.`;

const DECK = `# Deck: slides

A deck is a presentation. The kos-deck runtime fits each slide to the frame at 16:9 and handles navigation by keyboard, click and swipe, a slide counter, a grid of all slides, presenter notes, presenting full screen, and a reading layout on a phone. ${kindDefaults("deck")}

## Structure

    <main data-deck>
      <section class="title">
        <h1>Riverside Clinic: Online Booking</h1>
        <p>Operations review, 12 November 2026</p>
        <aside class="notes">Open with the call volume number.</aside>
      </section>
      <section>
        <h2>Calls peak at 9 a.m. and swamp the desk</h2>
        <div class="cols">...</div>
      </section>
      <section class="closing"><h2>Decision needed by Friday</h2></section>
    </main>

- One <section> per slide, in order. Presenter notes go in <aside class="notes"> inside the slide; they never show on the slide itself.
- Slide classes: .title (the opening slide), .statement (one large sentence or number), .split (two halves: text and a visual), .closing (the ask or summary), .bleed (a visual edge to edge).
- Helpers: .cols lays children in equal columns that stack on a phone; .big sets a key number very large; .kicker is a small label above a title; small or .muted is secondary text; td.num aligns figures.
- The runtime wraps each section in its own slide frame, so style slides with section or .deck-slide > section, never main > section, which no longer matches.
- Sizes come from the runtime's container units: --deck-title, --deck-heading, --deck-body, --deck-small, --deck-pad and --deck-gap. Use them, or calc() of them, for every font size and padding inside slides. Never px or rem font sizes in a slide: they do not scale with the slide.
- Slides are KOS's panel with a 1 px line, on KOS's ground, and follow the theme like everything else. --slide-bg and --slide-ink recolour them, for a distinctive deck only, with a value for each theme.

## Principles

- One idea per slide. If a slide needs two headings, it is two slides.
- Slide titles state the point as a sentence ("Online booking cut no-shows by a third"), not a topic ("Results").
- Type readable from the back of the room: body never smaller than --deck-body, and no more than about 3 short bullets on any slide. Fewer words, larger.
- A title slide first and a closing slide last: the closing slide holds the decision, the ask or the one thing to remember.
- Visuals over bullets: a chart drawn from the numbers, a simple diagram, a single big number with its unit and comparison.
- A consistent slide grid: the same padding, title position and edges on every slide, so moving between slides changes the content and not the frame.
- Charts on slides are simpler than on a page: one series highlighted, direct labels, no gridlines beyond what is needed.
- Put what you would say in the notes, not on the slide.
- A 6-slide deck is usually: title, the problem or context, two or three slides of evidence or plan, closing.

## Treatment

Decks take KOS's own look unless the deck is a brand or showcase piece: titles in KOS's face at 600 or 700, generous negative space, the accent for the one figure or word that matters on a slide. The title slide and the closing slide follow the theme like the rest: never invert one (a dark slide in light, a light one in dark) to make it feel like an opening. Keep contrast high, since slides are often projected. Avoid gradients behind text and decorative shapes that compete with the point. Do not build your own navigation, counters or keyboard handling; the runtime owns them.`;

const SHEET = `# Sheet: a spreadsheet

A sheet is a grid of data with formulas. The kos-sheet runtime draws the grid with typed columns, formulas, sorting, filtering, frozen headers, number formats in tabular figures, totals rows and charts. ${kindDefaults("sheet")}

## Structure

Put a short header (an h1 and one line of context) before the data, then one script holding the workbook as JSON:

    <header><h1>Household Expenses, Autumn 2026</h1><p>September to November, in CAD.</p></header>
    <script type="application/json" data-sheet>
    {"sheets":[
      {"name":"Expenses","freeze":1,
       "columns":[{"label":"Date","type":"date"},{"label":"Category","type":"text"},{"label":"Item","type":"text","width":28},{"label":"Amount","type":"currency","currency":"CAD"}],
       "rows":[["2026-09-02","Groceries","Sobeys",84.12],["2026-09-03","Transit","Bus pass",82]],
       "totals":{"Amount":"sum"}},
      {"name":"By category","columns":[{"label":"Category"},{"label":"Total","type":"currency","currency":"CAD"}],
       "pivot":{"from":"Expenses","by":"Category","values":[{"column":"Amount","fn":"sum"}]},
       "totals":{"Total":"sum"}}],
     "charts":[{"type":"bar","title":"Spend by category","sheet":"By category","labels":"A1:A6","values":"B1:B6"}]}
    </script>

- sheets: one or more tabs. Each has a name, its columns, and exactly one of rows (data kept with the artifact), source (a project table, live) or pivot (grouped from another tab).
- columns: label, type (text, number, currency, percent, date, bool), decimals, currency (an ISO code such as CAD), width in characters, and for a source tab the table column it shows.
- totals: a totals row under the grid, keyed by column label or letter, with sum, average, min, max or count. It totals the rows shown, so a filter narrows it.
- pivot: columns are referred to by label or letter. Declare the pivot tab's own columns (the group, then one per value) to name and format them; otherwise a sum keeps the column's name and the others say what they are ("Average Amount", "Count of Amount").
- freeze: how many columns from the left stay in view when scrolling sideways. The header row is always frozen.
- charts: bar, line or pie, each with a title, the tab, and A1-style ranges of one column each for labels and values.

## Formulas

Rows are numbered from 1 below the header, and column A is the first column. A cell that starts with "=" is a formula: + - * / ^ and & (join text), comparisons, references like A1 and $A$1, ranges like C1:C40, other tabs as Expenses!C1:C40 or 'By category'!B2, and the functions SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, IF, SUMIF, COUNTIF, AVERAGEIF and CONCAT. Percent values are fractions (0.15 shows as 15%).

## Data kept with it, or a project table

- With rows, the data lives in the artifact. The owner edits cells in the grid, and each save becomes a new version.
- With source: { table, key, orderBy }, the tab reads a project table live through window.kos. Name the PHYSICAL table. To let the owner edit it, declare the table in capabilities.writes with its editable columns, and give key as the column that identifies a row; edits go through KOS's guarded writes. Use a source tab whenever the data already lives in a project table, so the sheet never goes stale.

## Principles

- Choose the right type and format for every column: currency with its code, percent as a fraction, dates as ISO (2026-09-02), counts as numbers with no decimals. Numbers right-aligned in tabular figures come from the type; do not format them as text.
- Totals rows on the columns that add up, averages where a sum means nothing.
- Totals by category belong in a pivot tab, never typed by hand: they stay right when a row changes.
- Freeze the identifying column (a date, a name) when the sheet is wide.
- Widths that fit the content: a date column narrow, a description wide.
- Order rows the way the owner reads them, usually by date, and let sorting and filtering do the rest.
- A chart from a range when the shape matters more than the values: categories as a bar, time as a line, a pie only for a few shares of one whole.
- Use the real data the owner gave, every row of it, with messy values cleaned (quoted thousands, stray currency signs, duplicate headers) before they go in.
- Keep the page around the grid quiet: the title, one line of context, the grid and its charts, on KOS's ground with no background or header card of its own. The sheet is the content.`;

const PARTS: Record<ArtifactKind, string> = { page: PAGE, doc: DOC, deck: DECK, sheet: SHEET };

const POINTERS = [
  "# The kinds",
  "Ask for the part of the kind you are making: artifacts.guide({ kind }).",
  "- page: an app, dashboard or tool over a project's data, with window.kos.",
  "- doc: a designed document (report, plan, memo, brief, guide) the owner can edit in place.",
  "- deck: slides, with navigation, notes and presenting done by the runtime.",
  "- sheet: a spreadsheet with typed columns, formulas, totals and charts.",
].join("\n");

/** The general guide plus the part for one kind; with no kind, a pointer to each. Without a checker, the workflow says so. */
export function artifactGuide(kind?: ArtifactKind, canCheck = true): string {
  return [canCheck ? GENERAL : GENERAL.replace(CHECK_STEPS, NO_CHECK_STEPS), kind ? PARTS[kind] : POINTERS].join("\n\n");
}

/** The parts by name, for tests and for measuring them. */
export const GUIDE_PARTS = { general: GENERAL, ...PARTS } as const;
