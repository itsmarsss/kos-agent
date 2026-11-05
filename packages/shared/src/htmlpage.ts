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

/**
 * Ways a page could try to leave its frame, refused when it is written.
 *
 * The frame stops each of these at run time; this catches them in the open
 * first, with the reason, because a page that tries one only breaks (it has
 * no network to reach), and because one run-time leak is held here alone: a
 * navigation attempt still makes Chrome look up and connect to the host it
 * names before the frame's policy refuses it.
 */
const MARKUP_EXITS: [RegExp, string][] = [
  [/<link\b/i, "a <link> (a page loads nothing; prefetch and prerender links reach the network)"],
  [/<meta\b[^>]*http-equiv/i, "a <meta http-equiv> (a refresh would navigate)"],
  [/<(i?frame|frameset|object|embed|portal|fencedframe)\b/i, "a frame, object or embed"],
  [/<base\b/i, "a <base>"],
  [/<form\b/i, "a <form> (save with kos.write instead of posting)"],
  [/<script\b[^>]*speculationrules/i, "speculation rules"],
  [/<(a|area|form|button|input)\b[^>]*\s(target|formaction|ping)\s*=/i, "a link or form target"],
  [/<a\b[^>]*\bdownload\b/i, "a download link"],
];

/** The same in the page's code: its scripts, its inline handlers and javascript: links. */
const CODE_EXITS: [RegExp, string][] = [
  [/\blocation\s*(\.|\[|=(?!=))/, "a use of location (a page stays where it is)"],
  [/\b(window|self|top|parent|globalThis)\s*\.\s*open\s*\(/, "window.open"],
  [/\.\s*(submit|requestSubmit)\s*\(/, "a form submit"],
  [/\bnavigation\s*\.\s*navigate\b/, "navigation.navigate"],
];

/** A page's code, apart from its words: what a check of what it does should read. */
function codeOf(html: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => m[1]);
  const urls = [...html.matchAll(/javascript:[^"'>\s]*/gi)].map((m) => m[0]);
  return [...scripts, ...handlers, ...urls].join("\n");
}

/** What in a page's HTML would try to leave its frame, each named once. */
export function exitsIn(html: string): string[] {
  const code = codeOf(html);
  return [...MARKUP_EXITS.filter(([re]) => re.test(html)), ...CODE_EXITS.filter(([re]) => re.test(code))].map(([, what]) => what);
}
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
  else {
    const exits = exitsIn(p.html);
    if (exits.length) errors.push(`a page cannot leave its frame, so it may not hold ${exits.join("; ")}; keep everything on the page and reach data through window.kos`);
  }
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
