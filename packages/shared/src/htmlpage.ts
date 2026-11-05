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
  [/<([\w-]+:)?link\b/i, "a <link> (a page loads nothing; prefetch and prerender links reach the network)"],
  [/<meta\b[^>]*http-equiv/i, "a <meta http-equiv> (a refresh would navigate)"],
  [/<(i?frame|frameset|object|embed|portal|fencedframe)\b/i, "a frame, object or embed"],
  [/<base\b/i, "a <base>"],
  [/<form\b/i, "a <form> (save with kos.write instead of posting)"],
  [/<script\b[^>]*speculationrules/i, "speculation rules"],
  [/<(a|area|form|button|input)\b[^>]*\s(target|formaction|ping)\s*=/i, "a link or form target"],
  [/<a\b[^>]*\bdownload\b/i, "a download link"],
  [/<(a|area)\b[^>]*\shref\s*=\s*["']?\s*(?!javascript:)([a-z][a-z0-9+.-]*:|\/\/)/i, "a link off the page (link within it with #id)"],
];

/**
 * The same in the page's code: its scripts, its inline handlers and
 * javascript: links, read with its strings and comments blanked, so words
 * in them ("Pick a location") are not taken for what the code does.
 */
const CODE_EXITS: [RegExp, string][] = [
  [/\b(window|document|self|top|parent|globalThis|frames)\s*\.\s*location\b/, "a use of location (a page stays where it is)"],
  [/(?<![.\w$])(?<!\b(?:const|let|var)\s+)location\s*(=(?!=)|\[|\.\s*(href|assign|replace|reload|search|hash|pathname|host|hostname|protocol|port)\b)/, "a use of location (a page stays where it is)"],
  [/\b(window|self|top|parent|globalThis)\s*\.\s*open\s*\(/, "window.open"],
  [/(?<![.\w$])(?<!\bfunction\s+)open\s*\((?![^)]*\)\s*\{)/, "window.open"],
  [/\.\s*(submit|requestSubmit)\s*\(/, "a form submit"],
  [/\bnavigation\s*\.\s*navigate\b/, "navigation.navigate"],
  [/\.\s*(href|target|action|formAction|ping|download)\s*=(?!=)/, "setting a link's href or target (a page stays where it is)"],
  [/\b(webkit)?RTC(PeerConnection|DataChannel|RtpSender)\b/, "WebRTC (a page has no network)"],
];

/** Checks that need the strings: what they name is the point. */
const RAW_CODE_EXITS: [RegExp, string][] = [
  [/\[\s*["'`]location["'`]\s*\]/, "a use of location (a page stays where it is)"],
  [/setAttribute(NS)?\s*\(\s*([^,()]*,\s*)?["'`](href|xlink:href|target|action|formaction|ping|download|http-equiv)["'`]/i, "setting a link's href or target (a page stays where it is)"],
];

/**
 * Code with the insides of its strings, template text, regex literals and
 * comments blanked to spaces, the code around them and in `${}` kept. A
 * best reading, not a parser: it is what lets the checks above tell code
 * from words.
 */
function withoutLiterals(code: string): string {
  let out = "";
  let i = 0;
  // Whether a `/` here starts a regex: after an operator or at the start, not after a value.
  const regexMayStart = (): boolean => {
    const before = out.trimEnd();
    return before === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(before);
  };
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  const template = (): void => {
    out += "`";
    i += 1;
    while (i < code.length && code[i] !== "`") {
      if (code[i] === "\\") {
        out += "  ";
        i += 2;
      } else if (code[i] === "$" && code[i + 1] === "{") {
        out += "${";
        i += 2;
        let depth = 1;
        while (i < code.length && depth > 0) {
          if (code[i] === "{") depth += 1;
          if (code[i] === "}") depth -= 1;
          if (depth === 0) break;
          if (code[i] === "`") template();
          else if (code[i] === "'" || code[i] === '"') quoted(code[i]!);
          else out += code[i++];
        }
        out += "}";
        i += 1;
      } else {
        out += code[i] === "\n" ? "\n" : " ";
        i += 1;
      }
    }
    out += "`";
    i += 1;
  };
  const quoted = (q: string): void => {
    let j = i + 1;
    while (j < code.length && code[j] !== q && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
    out += q + blank(code.slice(i + 1, j)) + q;
    i = j + 1;
  };
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      out += blank(code.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += blank(code.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"') {
      quoted(c);
    } else if (c === "`") {
      template();
    } else if (c === "/" && regexMayStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== "\n" && (inClass || code[j] !== "/")) {
        if (code[j] === "\\") j += 1;
        else if (code[j] === "[") inClass = true;
        else if (code[j] === "]") inClass = false;
        j += 1;
      }
      out += "/" + blank(code.slice(i + 1, j)) + "/";
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** A page's code, apart from its words: what a check of what it does should read. */
function codeOf(html: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => {
    const v = m[1]!;
    return /^["']/.test(v) ? v.slice(1, -1) : v;
  });
  const urls = [...html.matchAll(/javascript:[^"'>\s]*/gi)].map((m) => m[0].slice("javascript:".length));
  return [...scripts, ...handlers, ...urls].join("\n");
}

/**
 * What in a page's HTML would try to leave its frame, each named once.
 *
 * Best effort, and not what keeps a page in: the frame does that at run time
 * (artifactdoc.ts). This names the attempt to the agent, and closes what the
 * frame cannot, a navigation's lookup of its host, for every way of writing
 * one this can see.
 */
export function exitsIn(html: string): string[] {
  const raw = codeOf(html);
  const code = withoutLiterals(raw);
  const found = [
    ...MARKUP_EXITS.filter(([re]) => re.test(html)),
    ...CODE_EXITS.filter(([re]) => re.test(code)),
    ...RAW_CODE_EXITS.filter(([re]) => re.test(raw)),
  ].map(([, what]) => what);
  return [...new Set(found)];
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
