/**
 * A doc's text as the owner edited it in place, put back into the document.
 *
 * Only the inside of the doc's `<article data-doc>` changes; everything
 * around it (the agent's styles, scripts, declarations) stays as written.
 * The edit is text the owner typed, so it may carry markup but never code:
 * a script, a handler or a javascript: URL in it is refused, as is anything
 * that would end the article early. The whole document then goes through
 * every check a write does (PageStore.writeHtml).
 */

/** Longest edited text taken; the document as a whole has its own cap. */
const DOC_EDIT_MAX = 300_000;

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

/** What makes edited text more than text, named for the refusal. */
const CODE: [RegExp, string][] = [
  [/<script\b/i, "a script"],
  [/<style\b/i, "a stylesheet"],
  [/<\/?article\b/i, "an article tag"],
  [/\son[a-z]+\s*=/i, "an event handler"],
  [/javascript\s*:/i, "a javascript: URL"],
];

/** The document with its doc's text replaced by the owner's edit. */
export function withDocText(html: string, text: string): string {
  if (text.length > DOC_EDIT_MAX) throw new Error(`the edited text is ${text.length} characters; the most is ${DOC_EDIT_MAX}`);
  const found = CODE.filter(([re]) => re.test(text)).map(([, what]) => what);
  if (found.length) throw new Error(`an edit is text, so it may not hold ${found.join(", ")}`);
  const region = docRegion(html);
  if (!region) throw new Error("this doc has no <article data-doc> to edit");
  return html.slice(0, region.start) + text + html.slice(region.end);
}
