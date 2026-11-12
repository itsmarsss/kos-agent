// A doc, a deck and a sheet as KOS draws them for a phone (docs/computer.md, Artifacts), for the viewer's renders:
// the dashboard's frame, from its own build, read-only, in each theme, with each theme's rule. The renders load them
// in the viewer's own web view, so what is drawn is what a phone would draw.
//
//   node scripts/artifact-fixtures.mjs <out dir>
//
// The KOS checkout's packages/harness/dist and packages/ui/dist must be built (pnpm build:ts, pnpm build:ui).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { artifactFrame, defaultPageLib, loadAssets } from "../../harness/dist/index.js";
import { tokenRule } from "../../shared/dist/index.js";

const out = process.argv[2];
if (!out) throw new Error("say where to write the fixtures");

const doc = `<article data-doc>
<p class="kicker">Garden · Spring</p>
<h1>Beds for the new season</h1>
<p class="lede">Four raised beds along the south fence, planted in two rounds so something is always coming up.</p>
<p class="byline">KOS · March</p>
<h2>What goes where</h2>
<p>The two beds nearest the house take the herbs and salad, picked most often. The far two take tomatoes and beans, which want the long sun.<span class="fn">The fence shades the first bed until ten in the morning.</span></p>
<table><thead><tr><th>Bed</th><th>First round</th><th>Second round</th></tr></thead>
<tbody><tr><td>1</td><td>Lettuce, rocket</td><td>Basil</td></tr><tr><td>2</td><td>Parsley, chives</td><td>Coriander</td></tr><tr><td>3</td><td>Peas</td><td>Tomatoes</td></tr><tr><td>4</td><td>Broad beans</td><td>Runner beans</td></tr></tbody></table>
<aside class="callout"><p>Order the soil by the 20th: the yard delivers on Saturdays only.</p></aside>
<h2>Costs</h2>
<p>Timber, soil and seed come to about $640, under the $700 set aside.</p>
</article>`;

const deck = `<main data-deck>
<section class="title"><p class="kicker">Garden plan</p><h1>Four beds, two rounds</h1><p>Spring and summer</p></section>
<section><h2>Why raised beds</h2><ul><li>The clay drains badly</li><li>Easier on the back</li><li>Warmer soil, earlier crops</li></ul></section>
<section class="statement"><h2>Something is always coming up.</h2></section>
<section class="closing"><h2>Order the soil by the 20th</h2></section>
</main>`;

const book = {
  sheets: [
    {
      name: "Costs",
      columns: [
        { label: "Item" },
        { label: "Where" },
        { label: "Qty", type: "number" },
        { label: "Each", type: "currency", currency: "USD" },
        { label: "Total", type: "currency", currency: "USD" },
        { label: "Due", type: "date" },
      ],
      rows: [
        ["Cedar boards", "Yard", 16, 18.5, "=C1*D1", "2026-03-14"],
        ["Screws", "Hardware", 2, 9, "=C2*D2", "2026-03-14"],
        ["Top soil", "Yard", 4, 42, "=C3*D3", "2026-03-20"],
        ["Compost", "Yard", 6, 11, "=C4*D4", "2026-03-20"],
        ["Seed", "Online", 9, 3.75, "=C5*D5", "2026-03-02"],
        ["Netting", "Hardware", 3, 14, "=C6*D6", "2026-04-01"],
      ],
      totals: { Total: "sum" },
      freeze: 1,
    },
  ],
};
const sheet = `<h1>Garden costs</h1><script type="application/json" data-sheet>${JSON.stringify(book)}</script>`;

const assets = loadAssets(defaultPageLib());
const themes = { light: tokenRule(assets.tokens.light, "light"), dark: tokenRule(assets.tokens.dark, "dark") };
mkdirSync(out, { recursive: true });
for (const [kind, title, html] of [["doc", "Beds for the new season", doc], ["deck", "Garden plan", deck], ["sheet", "Garden costs", sheet]]) {
  const page = { id: `garden-${kind}`, kind, title, html };
  const documents = { light: artifactFrame(page, "light", assets, { locked: true }), dark: artifactFrame(page, "dark", assets, { locked: true }) };
  writeFileSync(join(out, `${kind}.json`), JSON.stringify({ id: page.id, title, kind, documents, themes }));
}
console.log(`wrote doc, deck and sheet to ${out}`);
