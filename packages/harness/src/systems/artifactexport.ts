import type { CdpEvent } from "@kos/browser";
import {
  GUARD_SCRIPT,
  KIND_EXPORTS,
  PAGE_GUARD_CSP,
  artifactAssets,
  colourOf,
  exportName,
  fontById,
  fontFaceCss,
  fontStackVars,
  sheetDataOf,
  splitHtml,
  tokenRule,
  type ExportFormat,
  type HtmlPage,
  type SheetBook,
} from "@kos/shared";

import { writeZip } from "../files/zip.js";
import { defaultPageLib, loadAssets, parseRelay, type CheckBrowser, type FrameAssets, type Relayed, type Theme } from "./artifactcheck.js";
import { docMarkdown } from "./docmarkdown.js";
import { tabCsv, withSources } from "./sheetcsv.js";

/**
 * Artifacts taken away from KOS, as files: a doc as PDF, Markdown or HTML, a
 * deck as PDF (a slide a page) or HTML, a sheet's tabs as CSV or the sheet as
 * HTML, a page as PDF or HTML (KIND_EXPORTS).
 *
 * HTML is one file that opens anywhere, offline: the artifact's own markup
 * with its kind's runtime, the libraries it names, KOS's tokens for one
 * theme, the kit's stylesheet and its fonts, all inlined. window.kos is
 * there, but it reaches nothing: the reads the artifact made when it was
 * drawn for the export are frozen into the file and answered from it, and
 * everything else (a write, an ask, a save) is refused in words. The file
 * keeps the frame's policy, so it opens no connection either. Nothing of the
 * dashboard goes in it: no token, no address, only the artifact and what its
 * own reads answered.
 *
 * PDF is that same document printed by the Chrome artifacts.check keeps
 * (ArtifactChecker.withBrowser, one job at a time), in the light theme
 * unless asked otherwise: its reads answered live through the same checks
 * the dashboard's are, read-only, then Page.printToPDF. A deck prints by its
 * own print rules on 16:9 pages; a doc on Letter with margins, its runtime's
 * print rules keeping headings with what follows and figures and tables
 * whole.
 */

export interface ExportFile {
  body: Buffer;
  /** Its media type, as the response says it. */
  type: string;
  name: string;
}

export interface ExportOptions {
  theme?: Theme;
  /** A sheet's tab, by name, for one CSV; every tab is a zip of them. */
  tab?: string;
}

/** An export the artifact cannot give: the kind has no such format, or the tab is not there. */
export class ExportRefusal extends Error {}

export interface ExporterOptions {
  load: (id: string) => { page: HtmlPage; title: string } | undefined;
  /** A window.kos read (query or file), answered as the dashboard's server answers one. */
  call: (id: string, verb: "query" | "file", args: Record<string, unknown>) => Promise<unknown>;
  /** The check's Chrome, one job at a time. */
  browser: <T>(work: (browser: CheckBrowser) => Promise<T>) => Promise<T>;
  pageLib?: () => string;
}

/** A frozen read: what the artifact asked, by the key its bridge made, and what came back. */
export type Answers = Record<string, { result: unknown } | { error: string }>;

/** How long one export may take, its wait for the Chrome included. */
export const EXPORT_MS = 60_000;
/** Exports waiting on the Chrome at once; past it, the owner is told to wait. */
const BROWSER_QUEUE_MAX = 3;
/** How long a render waits for its runtime to draw and its reads to be answered. */
const SETTLE_MS = 8000;
/** Quiet time after the last read before the page is taken as drawn. */
const QUIET_MS = 700;
/** Past this the fonts stay out of an HTML file and their stacks fall back to the system's: four families are about half of it. */
const FONT_BUDGET = 600_000;
/** What a read said, at most, frozen in a file: a page of 500 rows fits many times over. */
const ANSWERS_MAX = 8_000_000;

/** The page in inches, for each kind's print: a deck's slide is 16:9, the rest US Letter. */
const PAPER = {
  deck: { paperWidth: 13.333, paperHeight: 7.5, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 },
  doc: { paperWidth: 8.5, paperHeight: 11, marginTop: 0.75, marginBottom: 0.75, marginLeft: 0.8, marginRight: 0.8 },
  page: { paperWidth: 8.5, paperHeight: 11, marginTop: 0.5, marginBottom: 0.5, marginLeft: 0.5, marginRight: 0.5 },
} as const;

/** The view a render lays out in: a deck on its own stage, the rest at the dashboard's desktop width. */
const VIEW = { deck: { width: 1280, height: 720 }, other: { width: 1280, height: 800 } } as const;

/**
 * What the exported file adds to the frame's own look: the gutter the
 * dashboard's column gives a frame, as padding on the root, since the
 * runtimes and the artifact own the body's (a deck keeps its stage, a page
 * on its own ground takes the kit's), and none on paper, where the print's
 * margins are.
 */
const EXPORT_CSS = `:where(html[data-export]:not([data-ground="own"]):not([data-kind="deck"])){padding:24px}
@media (max-width:560px){:where(html[data-export]:not([data-ground="own"]):not([data-kind="deck"])){padding:16px}}
@media print{:where(html[data-export]){padding:0}}`;

/**
 * A page printed on KOS's ground to the paper's edges, margins too, so its
 * panels sit on the ground they were drawn on rather than in a grey box on
 * white. A page's context does not inherit :root's tokens, so the colour is
 * written out. A doc prints on white (its runtime's print rules), a deck
 * edge to edge.
 */
const paperGround = (tokens: Record<string, string>): string => `@media print{@page{background:${(tokens["--bg"] ?? "transparent").replace(/[;{}<]/g, "")}}}`;

/** What the copy says when the artifact asks for what it does not have. */
const OFFLINE = "This is a copy of the artifact taken from KOS, so it has only the data it was exported with";

/**
 * window.kos in an exported document. With KOS's Chrome holding it (a
 * kosRelay binding), reads go to KOS and come back as the dashboard's do;
 * in the file, they are answered from what was frozen in it, by the same
 * key. Writes, asks and saves are refused; there is no save, so no runtime
 * offers editing. Present takes the window full screen, as the dashboard
 * would. A page that paints a ground of its own is marked as the frame's
 * bridge marks one.
 */
export function exportBridge(mode: Theme, answers: Answers | undefined): string {
  // JSON is valid script since ES2019, line separators too; only a "<" could close the element.
  const frozen = answers ? JSON.stringify(answers).replace(/</g, "\\u003c") : "null";
  return `(function(){
var __name=function(f){return f};
var frozen=${frozen},relay=typeof kosRelay==="function"?kosRelay:null,seq=0,waiting={},root=document.documentElement;
function key(m,a){return JSON.stringify([m,a])}
function read(m,a){var k=key(m,a);
if(!relay){var got=frozen&&Object.prototype.hasOwnProperty.call(frozen,k)?frozen[k]:null;if(!got)return Promise.reject(new Error(${JSON.stringify(`${OFFLINE}.`)}));return "error" in got?Promise.reject(new Error(got.error)):Promise.resolve(JSON.parse(JSON.stringify(got.result)))}
return new Promise(function(resolve,reject){var id=++seq;waiting[id]={resolve:resolve,reject:reject};relay(JSON.stringify({id:id,key:k,method:m,args:a}))})}
window.__kosReply=function(r){var w=waiting[r.id];if(!w)return;delete waiting[r.id];if(r.error)w.reject(new Error(r.error));else w.resolve(r.result)};
function refuse(what){return function(){return Promise.reject(new Error(${JSON.stringify(`${OFFLINE}: it `)}+what+"."))}}
function present(on){if(on)root.dataset.present="on";else delete root.dataset.present;dispatchEvent(new CustomEvent("kos:present",{detail:{on:on}}))}
document.addEventListener("fullscreenchange",function(){if(!document.fullscreenElement&&root.dataset.present)present(false)});
var kos={
query:function(sql,params){return read("query",params===undefined?{sql:sql}:{sql:sql,params:params})},
files:Object.freeze({read:function(path){return read("file",{path:path})}}),
write:refuse("changes nothing"),
ask:refuse("sends nothing to KOS"),
present:function(on){on=on!==false;if(on&&root.requestFullscreen)root.requestFullscreen().catch(function(){});else if(!on&&document.fullscreenElement)document.exitFullscreen().catch(function(){});present(on)},
onTheme:function(){},
refresh:function(){}
};
Object.defineProperty(kos,"theme",{get:function(){return ${JSON.stringify(mode)}},enumerable:true});
Object.defineProperty(window,"kos",{value:Object.freeze(kos)});
${colourOf.toString()}
function ground(){var b=document.body,t=/--bg:([^;}]+)/.exec((document.getElementById("kos-tokens")||{}).textContent||"");if(!b||!t)return;
var bs=getComputedStyle(b),c=colourOf(bs.backgroundColor),k=colourOf(t[1].trim());
var own=bs.backgroundImage!=="none"||(!!c&&!!k&&c[3]>0&&Math.max(Math.abs(c[0]-k[0]),Math.abs(c[1]-k[1]),Math.abs(c[2]-k[2]))>2);
if(own)root.dataset.ground="own";else delete root.dataset.ground}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ground);else ground();
addEventListener("load",ground);
})();`;
}

/** Keep a script's text from ending its element early. */
const scriptSafe = (code: string): string => code.replace(/<\/script/gi, "<\\/script");
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ExportDocumentInput {
  page: HtmlPage;
  title: string;
  mode: Theme;
  assets: FrameAssets;
  /** The reads to answer from the file; absent while KOS's Chrome answers them live. */
  answers?: Answers;
}

/** The fonts' faces, each file inlined, or none when they would make the file too large: their stacks fall back. */
function faces(page: HtmlPage, assets: FrameAssets): string {
  const fonts = artifactAssets(page).fonts.flatMap((id) => fontById(id) ?? []);
  let size = 0;
  const css = fontFaceCss(fonts, (file) => {
    const data = assets.font(file);
    size += data ? (data.length * 3) / 4 : 0;
    return data;
  });
  return size > FONT_BUDGET ? "" : css;
}

/**
 * The artifact as one document that stands alone: the frame's policy and
 * guard (the guard only where the browser has Trusted Types), the theme's
 * tokens, the kit, the fonts, the export's bridge, the libraries and
 * runtime, then the artifact's own head and body.
 */
export function exportDocument({ page, title, mode, assets, answers }: ExportDocumentInput): string {
  const libraries = artifactAssets(page).scripts.map((name) => {
    const code = assets.script(name);
    if (code === undefined) throw new Error(`the dashboard's build has no ${name}; build the UI so KOS can export artifacts`);
    return code;
  });
  const { head, body } = splitHtml(page.html);
  const kind = page.kind ?? "page";
  return [
    "<!doctype html>",
    `<html data-mode="${mode}" data-theme="${mode}" data-kind="${kind}" data-export><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_GUARD_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<script>if(typeof trustedTypes==="object"&&trustedTypes)${GUARD_SCRIPT}</script>`,
    `<style id="kos-tokens">${tokenRule(assets.tokens[mode], mode)}</style>`,
    `<style>${`${assets.css}\n${fontStackVars()}\n${faces(page, assets)}\n${EXPORT_CSS}\n${kind === "page" ? paperGround(assets.tokens[mode]) : ""}`.replace(/<\/style/gi, "")}</style>`,
    `<script>${scriptSafe(exportBridge(mode, answers))}</script>`,
    ...libraries.map((code) => `<script>${scriptSafe(code)}</script>`),
    head,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/** Whether an artifact reads anything when drawn, so its export must draw it first to freeze what it read. */
function reads(page: HtmlPage): boolean {
  if (page.kind === "sheet") {
    try {
      if ((JSON.parse(sheetDataOf(page.html) ?? "{}") as Partial<SheetBook>).sheets?.some((t) => t.source)) return true;
    } catch {
      return false;
    }
  }
  return /\bkos\s*\.\s*(query|files)\b/.test(page.html);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(work: Promise<T>, ms: number, words: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(words)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class ArtifactExporter {
  /** Exports holding or waiting for the Chrome. */
  private printing = 0;

  constructor(private readonly options: ExporterOptions) {}

  /** The file, or a refusal: the format must be one the kind has. */
  async export(id: string, format: ExportFormat, { theme = "light", tab }: ExportOptions = {}): Promise<ExportFile> {
    const got = this.options.load(id);
    if (!got) throw new ExportRefusal("artifact not found");
    const { page, title } = got;
    const kind = page.kind ?? "page";
    if (!KIND_EXPORTS[kind].includes(format)) throw new ExportRefusal(`a ${kind} exports as ${KIND_EXPORTS[kind].join(", ")}, not ${format}`);
    if (tab !== undefined && format !== "csv") throw new ExportRefusal("only a sheet's CSV takes a tab");
    if (format === "md") return { body: Buffer.from(docMarkdown(page.html), "utf8"), type: "text/markdown; charset=utf-8", name: exportName(title, "md") };
    if (format === "csv") return this.csv(id, page, title, tab);
    const assets = loadAssets((this.options.pageLib ?? defaultPageLib)());
    if (format === "html") {
      const answers = reads(page) ? (await this.inChrome(() => this.draw(id, page, title, theme, assets, "record"))) as Answers : undefined;
      const html = exportDocument({ page, title, mode: theme, assets, answers: answers ?? {} });
      return { body: Buffer.from(html, "utf8"), type: "text/html; charset=utf-8", name: exportName(title, "html") };
    }
    const pdf = (await this.inChrome(() => this.draw(id, page, title, theme, assets, "print"))) as Buffer;
    return { body: pdf, type: "application/pdf", name: exportName(title, "pdf") };
  }

  private async csv(id: string, page: HtmlPage, title: string, tab: string | undefined): Promise<ExportFile> {
    let book: SheetBook;
    try {
      book = JSON.parse(sheetDataOf(page.html) ?? "") as SheetBook;
    } catch {
      throw new ExportRefusal("the sheet's data cannot be read, so it has nothing to export");
    }
    const filled = await withSources(book, (sql) => this.options.call(id, "query", { sql }) as Promise<{ rows: Record<string, unknown>[] }>);
    const csv = (name: string): ExportFile => {
      const t = filled.sheets.findIndex((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (t < 0) throw new ExportRefusal(`the sheet has no tab called "${name}"`);
      const many = filled.sheets.length > 1;
      return { body: Buffer.from(tabCsv(filled, t), "utf8"), type: "text/csv; charset=utf-8", name: exportName(many ? `${title} ${filled.sheets[t]!.name}` : title, "csv") };
    };
    if (tab !== undefined || filled.sheets.length === 1) return csv(tab ?? filled.sheets[0]!.name);
    const entries: Record<string, string> = {};
    filled.sheets.forEach((s, t) => {
      let name = exportName(s.name, "csv");
      for (let n = 2; name in entries; n++) name = exportName(`${s.name} ${n}`, "csv");
      entries[name] = tabCsv(filled, t);
    });
    return { body: Buffer.from(writeZip(entries, { deflate: true })), type: "application/zip", name: exportName(title, "zip") };
  }

  /** Work on the Chrome, refused when too many exports already wait for it, and given up past EXPORT_MS. */
  private async inChrome<T>(work: () => Promise<T>): Promise<T> {
    if (this.printing >= BROWSER_QUEUE_MAX) throw new ExportRefusal("KOS is already exporting several artifacts; try again in a moment");
    this.printing += 1;
    try {
      return await within(work(), EXPORT_MS, "the export took too long; try again, or export another format");
    } finally {
      this.printing -= 1;
    }
  }

  /**
   * Draw the export's document in the check's Chrome, its reads answered
   * live, then keep what they answered ("record") or print it ("print").
   */
  private draw(id: string, page: HtmlPage, title: string, theme: Theme, assets: FrameAssets, then: "record" | "print"): Promise<Answers | Buffer> {
    return this.options.browser(async ({ cdp, serve }) => {
      const kind = page.kind ?? "page";
      const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      const answers: Answers = {};
      let size = 0;
      let inFlight = 0;
      let lastCall = Date.now();
      const reply = (args: Record<string, unknown>): Promise<unknown> =>
        cdp.send("Runtime.evaluate", { expression: `window.__kosReply(${JSON.stringify(args)})` }, sessionId).catch(() => undefined);
      const heard = (e: CdpEvent): void => {
        if (e.sessionId !== sessionId || e.method !== "Runtime.bindingCalled") return;
        const p = e.params as { name?: string; payload?: unknown };
        const m = p.name === "kosRelay" ? (parseRelay(p.payload) as (Relayed & { key?: unknown }) | undefined) : undefined;
        if (!m || m.id === undefined || typeof m.key !== "string") return;
        const key = m.key;
        const verb = m.method === "query" || m.method === "file" ? m.method : undefined;
        inFlight += 1;
        lastCall = Date.now();
        // Reads only: an export, like a check, never writes, asks or saves.
        const asked = verb ? this.options.call(id, verb, m.args ?? {}) : Promise.reject(new Error("an export only reads"));
        void asked
          .then(
            (result) => {
              size += JSON.stringify(result ?? null).length;
              if (size <= ANSWERS_MAX) answers[key] = { result };
              return reply({ id: m.id, result });
            },
            (err: unknown) => {
              const error = err instanceof Error ? err.message : String(err);
              answers[key] = { error };
              return reply({ id: m.id, error });
            },
          )
          .finally(() => {
            inFlight -= 1;
            lastCall = Date.now();
          });
      };
      const off = cdp.on(heard);
      try {
        const view = kind === "deck" ? VIEW.deck : VIEW.other;
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.addBinding", { name: "kosRelay" }, sessionId);
        await cdp.send("Emulation.setDeviceMetricsOverride", { ...view, deviceScaleFactor: 1, mobile: false }, sessionId);
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, sessionId);
        await cdp.send("Page.navigate", { url: await serve(exportDocument({ page, title, mode: theme, assets })) }, sessionId);
        const start = Date.now();
        await sleep(400);
        while (Date.now() - start < SETTLE_MS && (inFlight > 0 || Date.now() - lastCall < QUIET_MS)) await sleep(100);
        await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready.then(function(){return true})", awaitPromise: true }, sessionId).catch(() => undefined);
        if (then === "record") return answers;
        const printed = (await cdp.send(
          "Page.printToPDF",
          { ...PAPER[kind === "deck" ? "deck" : kind === "doc" ? "doc" : "page"], printBackground: true, preferCSSPageSize: false, displayHeaderFooter: false },
          sessionId,
          EXPORT_MS,
        )) as { data: string };
        return Buffer.from(printed.data, "base64");
      } finally {
        off();
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    });
  }
}

