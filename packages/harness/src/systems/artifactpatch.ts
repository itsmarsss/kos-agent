/**
 * A change to part of an artifact: edits applied to its stored HTML, in
 * order, to a copy, so either every one applies or none does. What comes out
 * is a whole document again, which the store then writes as any write is
 * written (PageStore.patch), with every check that holds.
 *
 * An edit names its place in one of two ways:
 *
 * - `{ find, replace }`: an exact piece of the stored HTML, which must occur
 *   exactly once, or `all: true` to replace every occurrence;
 * - `{ id, html }`: the one element with that id, replaced whole (its
 *   outerHTML), found by parsing the HTML as the browser does (markup.ts).
 */

import { elementSpan } from "./markup.js";

export type PatchEdit = { find: string; replace: string; all?: boolean } | { id: string; html: string };

/** The most edits one patch takes: a patch is a few targeted changes, not a rewrite. */
export const PATCH_EDITS_MAX = 50;

/** What the runtime draws into a doc and takes out again before it is saved: never part of what is stored. */
const GENERATED = /data-kos-gen/i;

/** A model writing JSON escapes a closing tag as <\/; it is stored as </ (PageStore.keepHtml), so it is matched so. */
const unescapeClosing = (s: string): string => s.replace(/<\\\//g, "</");

/** The edits as given, checked for shape: one list of `{ find, replace, all? }` and `{ id, html }`. */
export function patchEdits(input: unknown): PatchEdit[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("edits is a list of at least one { find, replace } or { id, html }");
  if (input.length > PATCH_EDITS_MAX) throw new Error(`a patch takes at most ${PATCH_EDITS_MAX} edits; rewrite it with artifacts.write instead`);
  return input.map((raw, i): PatchEdit => {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.find === "string" && typeof e.replace === "string" && e.id === undefined && e.html === undefined) {
      if (e.find === "") throw new Error(`edit ${i + 1}: find is empty; give an exact piece of the stored HTML`);
      if (e.all !== undefined && typeof e.all !== "boolean") throw new Error(`edit ${i + 1}: all is true or false`);
      return { find: unescapeClosing(e.find), replace: e.replace, ...(e.all ? { all: true } : {}) };
    }
    if (typeof e.id === "string" && typeof e.html === "string" && e.find === undefined && e.replace === undefined) {
      if (e.id === "") throw new Error(`edit ${i + 1}: id is empty`);
      return { id: e.id, html: e.html };
    }
    throw new Error(`edit ${i + 1} is neither { find, replace, all? } nor { id, html }`);
  });
}

/** Every place `find` starts in `html`, not overlapping. */
function occurrences(html: string, find: string): number[] {
  const at: number[] = [];
  for (let i = html.indexOf(find); i !== -1; i = html.indexOf(find, i + find.length)) at.push(i);
  return at;
}

/**
 * The HTML with every edit applied, in order, each to what the ones before
 * it left; and how many places changed. A refusal names the edit and leaves
 * nothing changed, since the edits are applied to a copy.
 */
export function applyPatch(html: string, edits: PatchEdit[]): { html: string; replaced: number } {
  let out = html;
  let replaced = 0;
  for (const [i, edit] of edits.entries()) {
    const n = `edit ${i + 1}`;
    const added = "find" in edit ? edit.replace : edit.html;
    if (GENERATED.test(added)) throw new Error(`${n} adds data-kos-gen markup, which a doc's runtime draws and takes out again; patch the stored HTML (artifacts.get), not the page as drawn`);
    if ("find" in edit) {
      const at = occurrences(out, edit.find);
      if (at.length === 0) {
        throw new Error(`${n}: find does not occur in the stored HTML. Match it exactly, whitespace and entities included, against artifacts.get's html; a doc's contents and note and figure numbers are drawn by its runtime and are not stored`);
      }
      if (at.length > 1 && !edit.all) throw new Error(`${n}: find occurs ${at.length} times; make it longer so it occurs once, or set all: true to replace every one`);
      // Sliced, not String.replace, so a $ in the replacement is the owner's text and not a pattern.
      for (const start of at.reverse()) out = out.slice(0, start) + edit.replace + out.slice(start + edit.find.length);
      replaced += at.length;
    } else {
      const span = elementSpan(out, edit.id);
      if ("refusal" in span) throw new Error(`${n}: ${span.refusal}; address it with find instead, or give it a unique id`);
      out = out.slice(0, span.start) + edit.html + out.slice(span.end);
      replaced += 1;
    }
  }
  return { html: out, replaced };
}

/**
 * How a patch changed the document, in a line's worth: the lines that went
 * and came, counted as two bags of lines (so a line only moved is not
 * counted), and the size either side.
 */
export function patchSummary(before: string, after: string): { lines: { removed: number; added: number; of: number }; bytes: { before: number; after: number } } {
  const a = before.split("\n");
  const b = after.split("\n");
  const count = new Map<string, number>();
  for (const line of a) count.set(line, (count.get(line) ?? 0) + 1);
  for (const line of b) count.set(line, (count.get(line) ?? 0) - 1);
  let removed = 0;
  let added = 0;
  for (const n of count.values()) {
    if (n > 0) removed += n;
    else added -= n;
  }
  return { lines: { removed, added, of: b.length }, bytes: { before: Buffer.byteLength(before), after: Buffer.byteLength(after) } };
}
