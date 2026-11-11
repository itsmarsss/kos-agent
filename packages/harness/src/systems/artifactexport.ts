import type { CdpClient } from "@kos/browser";
import {
  GUARD_SCRIPT,
  RTC_GUARD,
  KIND_EXPORTS,
  PAGE_GUARD_CSP,
  WRAPPER_CSP,
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
import { artifactFrame, defaultPageLib, hostDocument, loadAssets, type CheckBrowser, type FrameAssets, type Theme } from "./artifactcheck.js";
import { docMarkdown } from "./docmarkdown.js";
import { SNAPSHOT, SealedTab, type RelayedCall } from "./exportrender.js";
import { printDocument, withoutExits } from "./printsafe.js";
import { SourceRefusal, tabCsv, withSources, type SourcePage } from "./sheetcsv.js";

/**
 * Artifacts taken away from KOS, as files: a doc as PDF, Markdown or HTML, a
 * deck as PDF (a slide a page) or HTML, a sheet's tabs as CSV or the sheet as
 * HTML, a page as PDF or HTML (KIND_EXPORTS).
 *
 * The artifact is KOS's own code only in its runtime; the rest is whatever
 * the agent wrote, which may try to send what it reads somewhere. So it is
 * never run as a page of its own: every render, and the saved file, hold it
 * as the dashboard does, in a sandboxed srcdoc frame (scripts only) inside a
 * wrapper whose policy lets that frame hold about: documents alone, where a
 * navigation, a popup or a request goes nowhere.
 *
 * HTML is one file that opens anywhere, offline (savedFile): the artifact's
 * markup with its kind's runtime, the libraries it names, KOS's tokens for
 * one theme, the kit's stylesheet and its fonts, all inlined, in that frame.
 * window.kos is there but reaches nothing: an artifact that reads is drawn
 * once first, and what its reads answered is frozen into the file and
 * answered from it; a write, an ask or a save is refused in words. Nothing
 * of the dashboard goes in: no token, no address.
 *
 * Every render runs in the check's Chrome (ArtifactChecker.withBrowser, one
 * job at a time) in a sealed tab (exportrender.ts): every request but the one
 * document KOS serves is refused, a window it opens is closed, and its relay
 * is heard from that document alone. The artifact is drawn in its wrapper as
 * on the dashboard (hostDocument), its reads answered live through the same
 * checks, read-only. A PDF is then the frame as it was drawn (SNAPSHOT),
 * which the artifact's own code had the last word on, so it is rebuilt on
 * the server against an allowlist (printsafe.ts) and printed in a second
 * sealed tab with no request, no script in any frame and no network, in the light
 * theme unless asked otherwise: a deck by its own print rules on 16:9 pages,
 * a doc on Letter with margins, keeping headings with what follows and
 * figures and tables whole. An export given up past its timeout has its
 * tabs closed and its Chrome stopped.
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
  /** How long one export may take, its wait for the Chrome included; EXPORT_MS unless a test says less. */
  timeoutMs?: number;
}

/** A frozen read: what the artifact asked, by the key its bridge made, and what came back. */
export type Answers = Record<string, { result: unknown } | { error: string }>;

/** How long one export may take, its wait for the Chrome included. */
export const EXPORT_MS = 60_000;
/** Exports waiting on the Chrome at once; past it, the owner is told to wait. */
const BROWSER_QUEUE_MAX = 3;
/** How long a render waits for its runtime to draw and its reads to be answered. */
const SETTLE_MS = 8000;
/** What the CDP client says when the Chrome it talked to is gone. */
const BROWSER_GONE = /hung up|connection closed|not connected to the browser|Target closed|could not reach the browser/i;
/** How long a frame has to answer KOS's question about it; a frame that cannot is busy for good. */
const ANSWER_MS = 3000;
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
 * window.kos in an exported file: reads answered from what was frozen in
 * it, by the key the dashboard's bridge would send them under; writes, asks
 * and saves refused in words, and no save, so no runtime offers editing.
 * Present takes the window full screen, as the dashboard would. A link to a
 * place on the page scrolls there: in a srcdoc frame it would resolve
 * against the file's address and the frame's policy would refuse it. A page
 * that paints a ground of its own is marked as the frame's bridge marks one.
 */
export function exportBridge(mode: Theme, answers: Answers): string {
  // JSON is valid script since ES2019, line separators too; only a "<" could close the element.
  const frozen = JSON.stringify(answers).replace(/</g, "\\u003c");
  return `(function(){
var __name=function(f){return f};
var frozen=${frozen},root=document.documentElement,own=Object.prototype.hasOwnProperty;
function read(m,a){var k=JSON.stringify([m,a]),got=own.call(frozen,k)?frozen[k]:null;
if(!got)return Promise.reject(new Error(${JSON.stringify(`${OFFLINE}.`)}));
return "error" in got?Promise.reject(new Error(got.error)):Promise.resolve(JSON.parse(JSON.stringify(got.result)))}
function refuse(what){return function(){return Promise.reject(new Error(${JSON.stringify(`${OFFLINE}: it `)}+what+"."))}}
function present(on){if(on)root.dataset.present="on";else delete root.dataset.present;dispatchEvent(new CustomEvent("kos:present",{detail:{on:on}}))}
document.addEventListener("fullscreenchange",function(){if(!document.fullscreenElement&&root.dataset.present)present(false)});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href^='#']"):null;if(!a||e.defaultPrevented)return;e.preventDefault();var id=decodeURIComponent(a.getAttribute("href").slice(1)),t=id?document.getElementById(id):null;if(t)t.scrollIntoView({block:"start"});else if(!id)scrollTo(0,0)});
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
var mine=bs.backgroundImage!=="none"||(!!c&&!!k&&c[3]>0&&Math.max(Math.abs(c[0]-k[0]),Math.abs(c[1]-k[1]),Math.abs(c[2]-k[2]))>2);
if(mine)root.dataset.ground="own";else delete root.dataset.ground}
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
  /** The reads to answer from the file. */
  answers: Answers;
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
 * The artifact's own document in an exported file: the frame's policy and
 * guard (on Trusted Types where the browser has them, on each sink where
 * not), the theme's
 * tokens, the kit, the fonts, the frozen bridge, the libraries and runtime,
 * then the artifact's own head and body.
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
    // WebRTC and frames' windows go first; the guard runs whether or not the browser has Trusted Types.
    `<script>${RTC_GUARD}</script>`,
    `<script>${GUARD_SCRIPT}</script>`,
    `<style id="kos-tokens">${tokenRule(assets.tokens[mode], mode)}</style>`,
    `<style>${`${assets.css}\n${fontStackVars()}\n${faces(page, assets)}\n${EXPORT_CSS}`.replace(/<\/style/gi, "")}</style>`,
    `<script>${scriptSafe(exportBridge(mode, answers))}</script>`,
    ...libraries.map((code) => `<script>${scriptSafe(code)}</script>`),
    head,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/**
 * The exported HTML file: the artifact never runs as the file itself, which
 * a browser opens with the file's own reach. It runs in a sandboxed srcdoc
 * frame, scripts only (no popups, no top navigation, no forms), inside an
 * outer page that runs nothing of its own, under the dashboard wrapper's
 * policy (WRAPPER_CSP: no network, no connection, and a frame that may hold
 * about: documents alone). A frame's navigation is checked against its parent's
 * policy and a srcdoc frame inherits it, so the artifact cannot send itself
 * or what it read anywhere, as on the dashboard.
 */
export function savedFile(inner: string, title: string, mode: Theme, ground: string): string {
  const css = `html,body{margin:0;height:100%;background:${ground.replace(/[;{}<]/g, "")}}iframe{display:block;border:0;width:100%;height:100%}`;
  return [
    "<!doctype html>",
    `<html data-theme="${mode}"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${css}</style>`,
    "</head><body>",
    `<iframe sandbox="allow-scripts" allow="fullscreen" referrerpolicy="no-referrer" title="${escapeHtml(title)}" srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`,
    "</body></html>",
  ].join("");
}

/**
 * Whether an export must draw the artifact first to freeze what it read: a
 * page always (its code may read by any name), a sheet with a source tab,
 * and a doc or a deck that names window.kos at all.
 */
function reads(page: HtmlPage): boolean {
  const kind = page.kind ?? "page";
  if (kind === "page") return true;
  if (kind === "sheet") {
    try {
      return (JSON.parse(sheetDataOf(page.html) ?? "{}") as Partial<SheetBook>).sheets?.some((t) => t.source) === true;
    } catch {
      return false;
    }
  }
  return /\bkos\b/.test(page.html);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One export's hold on the Chrome: the tabs it opened, closed when it is given up, and the Chrome with them. */
class Job {
  aborted = false;
  private cdp: CdpClient | undefined;
  private reset: (() => void) | undefined;
  private readonly targets = new Set<string>();

  start(browser: CheckBrowser): void {
    if (this.aborted) throw new Error("the export was given up before it started");
    this.cdp = browser.cdp;
    this.reset = browser.reset;
  }

  /** Whether the Chrome this job was handed has gone. */
  get browserGone(): boolean {
    return this.cdp !== undefined && !this.cdp.open;
  }

  track = (targetId: string): void => {
    this.targets.add(targetId);
    if (this.aborted) this.close(targetId);
  };

  /** Its tabs closed and, since a page that spins holds its renderer whatever closes, the Chrome it ran in stopped. */
  abort(): void {
    this.aborted = true;
    for (const t of this.targets) this.close(t);
    this.reset?.();
  }

  private close(targetId: string): void {
    void this.cdp?.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/** What a render yields: the reads it answered, and the frame as drawn when it is to be printed. */
interface Drawn {
  answers: Answers;
  snapshot?: string;
}

export class ArtifactExporter {
  /** Exports holding or waiting for the Chrome, until their work has ended, given up or not. */
  private printing = 0;
  private readonly timeoutMs: number;

  constructor(private readonly options: ExporterOptions) {
    this.timeoutMs = options.timeoutMs ?? EXPORT_MS;
  }

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
      const answers = reads(page) ? (await this.inChrome((cdp, job) => this.draw(cdp, job, id, page, theme, assets, false))).answers : {};
      const html = savedFile(exportDocument({ page: { ...page, html: withoutExits(page.html) }, title, mode: theme, assets, answers }), title, theme, assets.tokens[theme]["--bg"] ?? "transparent");
      return { body: Buffer.from(html, "utf8"), type: "text/html; charset=utf-8", name: exportName(title, "html") };
    }
    const pdf = await this.inChrome(async (cdp, job) => {
      const { snapshot } = await this.draw(cdp, job, id, page, theme, assets, true);
      return this.print(cdp, job, kind, snapshot!, assets.tokens[theme]);
    });
    return { body: pdf, type: "application/pdf", name: exportName(title, "pdf") };
  }

  private async csv(id: string, page: HtmlPage, title: string, tab: string | undefined): Promise<ExportFile> {
    let book: SheetBook;
    try {
      book = JSON.parse(sheetDataOf(page.html) ?? "") as SheetBook;
    } catch {
      throw new ExportRefusal("the sheet's data cannot be read, so it has nothing to export");
    }
    const filled = await withSources(book, (sql, params) => this.options.call(id, "query", { sql, params }) as Promise<SourcePage>).catch((err: unknown) => {
      throw err instanceof SourceRefusal ? new ExportRefusal(err.message) : err;
    });
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

  /**
   * Work on the Chrome: refused when too many exports already wait for it,
   * and given up past the timeout, its tabs closed so whatever it ran stops.
   * It counts against the limit until its work has truly ended.
   */
  private async inChrome<T>(work: (cdp: CdpClient, job: Job) => Promise<T>): Promise<T> {
    if (this.printing >= BROWSER_QUEUE_MAX) throw new ExportRefusal("KOS is already exporting several artifacts; try again in a moment");
    this.printing += 1;
    const job = new Job();
    const running = this.options.browser((browser) => {
      job.start(browser);
      return work(browser.cdp, job);
    }).catch((err: unknown) => {
      // The Chrome went from under the work (a crash, a stop): said in words, and the next export starts a fresh one.
      if (!job.aborted && (job.browserGone || BROWSER_GONE.test(String(err)))) throw new ExportRefusal("KOS's Chrome stopped while it drew the artifact, so there is nothing to export; try again");
      throw err;
    });
    void running.catch(() => undefined).finally(() => (this.printing -= 1));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        job.abort();
        reject(new Error("the export took too long; try again, or export another format"));
      }, this.timeoutMs);
    });
    return Promise.race([running, late]).finally(() => clearTimeout(timer));
  }

  /**
   * Draw the artifact as the dashboard does, in its wrapper and sandboxed
   * frame, in a sealed tab: its reads answered live through the same checks
   * the dashboard's are, and never a write. Then keep what they answered,
   * and, to print, the frame as it was drawn.
   */
  private async draw(cdp: CdpClient, job: Job, id: string, page: HtmlPage, theme: Theme, assets: FrameAssets, snapshot: boolean): Promise<Drawn> {
    const kind = page.kind ?? "page";
    const answers: Answers = {};
    let size = 0;
    let inFlight = 0;
    let lastCall = Date.now();
    let left = false;
    const relay = (call: RelayedCall | "left"): void => {
      if (call === "left") {
        left = true;
        return;
      }
      const key = JSON.stringify([call.method, call.args]);
      const verb = call.method === "query" || call.method === "file" ? call.method : undefined;
      inFlight += 1;
      lastCall = Date.now();
      // Reads only: an export, like a check, never writes, asks or saves.
      const asked = verb ? this.options.call(id, verb, call.args) : Promise.reject(new Error("an export only reads"));
      void asked
        .then(
          (result) => {
            size += JSON.stringify(result ?? null).length;
            if (verb && size <= ANSWERS_MAX) answers[key] = { result };
            return tab.reply({ id: call.id, result });
          },
          (err: unknown) => {
            const error = err instanceof Error ? err.message : String(err);
            if (verb) answers[key] = { error };
            return tab.reply({ id: call.id, error });
          },
        )
        .finally(() => {
          inFlight -= 1;
          lastCall = Date.now();
        });
    };
    const tab = await SealedTab.open(cdp, { scripts: true, offline: true, track: job.track }, relay);
    try {
      const view = kind === "deck" ? VIEW.deck : VIEW.other;
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...view, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, tab.sessionId);
      await tab.navigate(hostDocument(artifactFrame({ ...page, html: withoutExits(page.html) }, theme, assets), assets.tokens[theme]["--bg"]));
      const start = Date.now();
      await sleep(400);
      while (!job.aborted && Date.now() - start < SETTLE_MS && (inFlight > 0 || Date.now() - lastCall < QUIET_MS)) await sleep(100);
      if (job.aborted) throw new Error("the export was given up");
      if (!snapshot) return { answers };
      // A frame that tried to leave is refused by its wrapper and left with nothing to print.
      if (left) throw new ExportRefusal("the artifact tried to leave its frame, which KOS stops, so there is nothing to print; ask KOS to fix it");
      return { answers, snapshot: await this.snapshot(cdp, tab, job) };
    } finally {
      await tab.close();
    }
  }

  /**
   * The artifact's frame as drawn, read in the frame itself. A frame too busy
   * to answer (a page spinning its renderer) is given up at once, its Chrome
   * stopped with it, rather than waited on call after call.
   */
  private async snapshot(cdp: CdpClient, tab: SealedTab, job: Job): Promise<string> {
    let busy = false;
    for (const c of tab.contexts) {
      const is = (await cdp
        .send("Runtime.evaluate", { expression: 'typeof window.kos==="object"&&!!document.documentElement.dataset.kind', contextId: c.id, returnByValue: true }, c.sessionId, ANSWER_MS)
        .catch((err: unknown) => {
          busy ||= /timed out/.test(String(err));
          return undefined;
        })) as { result?: { value?: unknown } } | undefined;
      if (is?.result?.value !== true) continue;
      await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready.then(function(){return true})", contextId: c.id, awaitPromise: true }, c.sessionId, ANSWER_MS).catch(() => undefined);
      const out = (await cdp.send("Runtime.evaluate", { expression: SNAPSHOT, contextId: c.id, returnByValue: true }, c.sessionId)) as { result: { value?: unknown } };
      if (typeof out.result.value === "string") return out.result.value;
    }
    if (busy) {
      job.abort();
      throw new ExportRefusal("the artifact kept its frame too busy to finish drawing, so there is nothing to print; ask KOS to fix it");
    }
    throw new ExportRefusal("the artifact's frame never started: its document may be malformed");
  }

  /**
   * The drawn frame printed: its snapshot, which the artifact's own code had
   * the last word on, rebuilt on the server as a document safe to print
   * (printsafe.ts), put in a sealed tab with no request (setDocumentContent)
   * that runs no script in any frame and is offline from the start.
   */
  private async print(cdp: CdpClient, job: Job, kind: string, snapshot: string, tokens: Record<string, string>): Promise<Buffer> {
    const html = printDocument(snapshot, `@media print{html{padding:0}}${kind === "page" ? paperGround(tokens) : ""}`);
    const tab = await SealedTab.open(cdp, { scripts: false, offline: true, track: job.track });
    try {
      const view = kind === "deck" ? VIEW.deck : VIEW.other;
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...view, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await tab.setContent(html);
      await sleep(300);
      if (job.aborted) throw new Error("the export was given up");
      const printed = (await cdp.send(
        "Page.printToPDF",
        { ...PAPER[kind === "deck" ? "deck" : kind === "doc" ? "doc" : "page"], printBackground: true, preferCSSPageSize: false, displayHeaderFooter: false },
        tab.sessionId,
        this.timeoutMs,
      )) as { data: string };
      return Buffer.from(printed.data, "base64");
    } finally {
      await tab.close();
    }
  }
}
