/**
 * A doc's text as the owner edited it in place, put back into the document.
 *
 * Only the inside of the doc's `<article data-doc>` changes; everything
 * around it (the agent's styles, scripts, declarations) stays as written.
 * The edit is text the owner typed, so it may carry markup but never code:
 * it is parsed as the browser parses it, held to the elements and
 * attributes a doc is made of, and saved as written back out from the
 * parse, so nothing in it can end the article early. The whole document then goes through
 * every check a write does (PageStore.writeHtml).
 */

import { DOC_EDIT_MAX } from "@kos/shared";

import { docEditOf } from "./markup.js";

const OPEN = /<article\b[^>]*\sdata-doc\b[^>]*>/i;
const TAG = /<(\/?)article\b[^>]*>/gi;

/** Where the article's inside starts and ends in the HTML. */
function docRegion(html: string): { start: number; end: number } | undefined {
  const open = OPEN.exec(html);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  let depth = 1;
  TAG.lastIndex = start;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start, end: m.index };
  }
  return undefined;
}

/** The document with its doc's text replaced by the owner's edit, as parsed and checked (markup.ts). */
export function withDocText(html: string, text: string): string {
  if (text.length > DOC_EDIT_MAX) throw new Error(`the edited text is ${text.length} characters; the most is ${DOC_EDIT_MAX}`);
  const edit = docEditOf(text);
  const region = docRegion(html);
  if (!region) throw new Error("this doc has no <article data-doc> to edit");
  return html.slice(0, region.start) + edit + html.slice(region.end);
}
