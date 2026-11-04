import type { MutationTarget } from "./pagespec.js";

/**
 * A page as the agent writes it: one self-contained HTML document, the way a
 * Claude artifact is. It runs in a sandboxed frame on an opaque origin with
 * no network, and reaches KOS only through the shell's `window.kos` bridge,
 * which answers just what the page declares here. The declarations are the
 * contract; the server checks every bridge call against them, so a page can
 * claim anything in its script and still reach only these.
 */

/** The libraries KOS serves itself, inlined into the frame: never a CDN. */
export const PAGE_LIBRARIES = ["react", "charts"] as const;
export type PageLibrary = (typeof PAGE_LIBRARIES)[number];

export interface PageCapabilities {
  /** Read-only queries over the page's own project's tables. On unless set false. */
  query?: boolean;
  /** Tables the page may change, each with its columns and operations. */
  writes?: MutationTarget[];
  /** Read text files inside the project's folder. */
  files?: boolean;
  /** Offer a message to the project's chat; the owner confirms each one. */
  ask?: boolean;
}

/** The figure a project's card on Home shows, from one read-only query. */
export interface PageHeadline {
  label: string;
  query: string;
}

export interface HtmlPage {
  id: string;
  title: string;
  html: string;
  capabilities?: PageCapabilities;
  libraries?: PageLibrary[];
  headline?: PageHeadline;
}

/** Large enough for a rich page with inlined data, small enough to keep the frame quick. */
export const HTML_PAGE_MAX = 400_000;

const ID_RE = /^[a-z][a-z0-9_-]*$/i;
const OPS = ["insert", "update", "delete"];

/** What is wrong with a page, as sentences the agent can act on; empty when it is fine. */
export function validateHtmlPage(page: unknown): string[] {
  if (typeof page !== "object" || page === null) return ["page must be an object"];
  const p = page as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof p.id !== "string" || !ID_RE.test(p.id)) errors.push("id must be letters, digits, _ or -, starting with a letter");
  if (typeof p.title !== "string" || !p.title.trim()) errors.push("title is required");
  if (typeof p.html !== "string" || !p.html.trim()) errors.push("html is required");
  else if (p.html.length > HTML_PAGE_MAX) errors.push(`html is ${p.html.length} characters; the most is ${HTML_PAGE_MAX}`);
  if (p.libraries !== undefined) {
    if (!Array.isArray(p.libraries)) errors.push("libraries must be a list");
    else for (const lib of p.libraries) if (!(PAGE_LIBRARIES as readonly unknown[]).includes(lib)) errors.push(`library "${String(lib)}" is not one KOS serves (${PAGE_LIBRARIES.join(", ")})`);
  }
  if (p.headline !== undefined) {
    const h = p.headline as Record<string, unknown> | null;
    if (typeof h !== "object" || h === null || typeof h.label !== "string" || !h.label.trim() || typeof h.query !== "string" || !h.query.trim()) {
      errors.push("headline needs a label and a query");
    }
  }
  if (p.capabilities !== undefined) {
    const c = p.capabilities as Record<string, unknown> | null;
    if (typeof c !== "object" || c === null) errors.push("capabilities must be an object");
    else {
      for (const flag of ["query", "files", "ask"] as const) {
        if (c[flag] !== undefined && typeof c[flag] !== "boolean") errors.push(`capabilities.${flag} must be true or false`);
      }
      if (c.writes !== undefined) {
        if (!Array.isArray(c.writes)) errors.push("capabilities.writes must be a list");
        else
          c.writes.forEach((w: unknown, i: number) => {
            const t = w as Record<string, unknown> | null;
            if (typeof t !== "object" || t === null || typeof t.table !== "string" || !t.table) {
              errors.push(`capabilities.writes[${i}] needs a table`);
              return;
            }
            if (!Array.isArray(t.columns) || t.columns.length === 0 || t.columns.some((col) => typeof col !== "string" || !col)) {
              errors.push(`capabilities.writes[${i}] needs its editable columns`);
            }
            if (t.allow !== undefined && (!Array.isArray(t.allow) || t.allow.some((op) => !OPS.includes(op as string)))) {
              errors.push(`capabilities.writes[${i}].allow is any of ${OPS.join(", ")}`);
            }
          });
      }
    }
  }
  return errors;
}
