import { isDataUrl, urlFor } from "./address.js";
import type { CdpEvent } from "./cdp.js";
import * as inpage from "./inpage.js";
import { copyKey, parseKeys, type KeyPress } from "./keys.js";
import { controlsOf, HIDDEN_VALUE, holdsValue, indexOf, INDEX_MAX, Refs, secretField, treeOf, type AxNode, type Control, type PageIndex } from "./snapshot.js";
import { WAIT_FOR_MS, type Step } from "./steps.js";
import { boxesOf, pixelBoxes, steadyShot, type SecretBoxes } from "./boxes.js";
import { paintedJpeg } from "./paint.js";
import { echoPatterns, isDigitSlot, isSecretSlot, keepFilled, unechoed, type FilledValue, type Kin, type SecretSlot, type Taint } from "./taint.js";

/**
 * One tab's hands.
 *
 * Everything an agent does to a page goes through here, over Chrome's own
 * protocol on the tab's session: no daemon in between to lose a reply. Every
 * wait has a deadline and ends in an answer, so a slow page is reported as
 * still loading rather than as a failure, and nothing waits on a page
 * forever. A dialog is answered the moment it opens, since an open alert
 * holds every later command on the tab; what it said is told to the agent.
 * Clicks and keys are real input events, aimed at the middle of the element
 * after it is scrolled into view, and a click that would land on something
 * else (a cookie banner over the button) is refused, naming what is in the
 * way.
 */

/** One command of several sent together. */
export interface Call {
  method: string;
  params?: Record<string, unknown>;
}

/** A tab's commands, already addressed to it. */
export interface Session {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /**
   * Several commands in one round trip, where the line to the tab is long
   * (KOS for Chrome): in order, stopping at the first that fails, or side by
   * side when `parallel`. One answer or error for each; an error for each
   * not sent.
   */
  batch?(calls: Call[], parallel: boolean, timeoutMs?: number): Promise<(Record<string, unknown> | Error)[]>;
}

/**
 * Commands one by one, as a batch is answered: in order, stopping at the
 * first that fails (an error for it and for each after), or side by side.
 */
export async function sendEach(send: Session["send"], calls: Call[], parallel: boolean, timeoutMs?: number): Promise<(Record<string, unknown> | Error)[]> {
  const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
  if (parallel) return Promise.all(calls.map((c) => send(c.method, c.params, timeoutMs).catch(asError)));
  const out: (Record<string, unknown> | Error)[] = [];
  for (const c of calls) {
    const failed = out.find((r) => r instanceof Error);
    out.push(failed ? new Error(`not sent: ${failed.message}`) : await send(c.method, c.params, timeoutMs).catch(asError));
  }
  return out;
}

/** How long a page may take to be ready to read, and to load in full. */
export interface PageLimits {
  domMs: number;
  loadMs: number;
}

const LIMITS: PageLimits = { domMs: 20_000, loadMs: 30_000 };

/** A picture of the tab as `Page.masked` has it taken: base64, and the CSS size of the page it shows from the viewport's corner (0 when not known). */
export interface PageShot {
  data: string;
  width: number;
  height: number;
}

export interface PageOptions {
  now?: () => number;
  limits?: Partial<PageLimits>;
  /**
   * Waited on before each call and each step: while the owner has taken the
   * tab, the agent's hands wait for them to let go. True when it waited, so
   * the agent is told the page may have changed under it. Once `signal`
   * aborts, the wait is dropped.
   */
  gate?: (signal?: AbortSignal) => Promise<boolean>;
  /** The tabs this one shares its secrets with (its conversation's), looked up at each use: none for a tab of no one's. */
  kin?: () => Kin | undefined;
  /** Every saved value, cleaned out of what KOS reads back from any tab: kept in the host, never sent into a page. */
  saved?: () => readonly FilledValue[];
  /** The saved values a page on these origins may be shown, to mask its pictures: those of secrets for its site. */
  savedFor?: (origins: readonly string[]) => readonly FilledValue[];
  /** Why no script of KOS's runs on an origin, if none may: a site a saved secret may be filled on. */
  evalBlocked?: (origin: string) => string | undefined;
  /** The documents (by loader) of this tab a script of KOS's ran in or could reach, kept by whoever outlives the Page. */
  scripted?: { has(loader: string): boolean; mark(loader: string): void };
  /** Waited on before a fill: work that must be done first (a credential site's service workers cleared). */
  settled?: () => Promise<void>;
  /**
   * Why no secret may go into a frame on `origin` of a document that began
   * at `loadedAt` (0: before KOS came to it), with a service worker
   * controlling the frame or not, if none may: its site's workers were not
   * cleared, or the document is from before they were.
   */
  workerBar?: (origin: string, loadedAt: number, controlled: boolean) => Promise<string | undefined>;
  /** A clock that only goes forward, which documents' starts are told by against the purges of their sites' workers. */
  tick?: () => number;
  /**
   * Puts a secret into a field itself, where the browser is one that does
   * (KOS for Chrome's secret.fill): the value goes there and nowhere else,
   * and it throws unless the field holds it. Without it the Page sets the
   * value through its own world.
   */
  putSecret?: (put: SecretPut) => Promise<void>;
  /**
   * What the browser says this tab is held to by a secret filled before
   * this Page (KOS for Chrome keeps it across sessions): the document, and
   * the addresses of documents, a secret was in. Either is held as a whole
   * page, since which fields hold it is not known here.
   */
  heldElsewhere?: () => HeldElsewhere | undefined;
}

/** A tab's hold as the browser that fills reports it (heldElsewhere). */
export interface HeldElsewhere {
  loader: string;
  urls: string[];
}

/** A secret for one field, as a browser that puts it in itself is given it: where it goes, what must hold there, and the value. */
export interface SecretPut {
  node: number;
  frame: string;
  doc: string;
  origin: string;
  frameOrigin: string;
  slot: SecretSlot;
  value: string;
}
/** After an action: how long a navigation it started may take. */
const SETTLE_NAV_MS = 10_000;
/** The page has answered once its document has not changed for this long, with none of the requests it waits on open. */
const DOM_QUIET_MS = 150;
/** After one of those requests ends, or a message comes on a socket, time for the page to show what it brought. */
const ANSWER_MS = 60;
/** After one the action started ends, time for the page to read what it brought and draw it (a parse, then a render). */
const ANSWERED_MS = ANSWER_MS + DOM_QUIET_MS;
/** The most an action waits for that, after any navigation it started, while nothing it started is still coming. */
const SETTLE_MAX_MS = 800;
/** The most it waits while a request the action started is still open. */
const SETTLE_BUSY_MS = 2_500;
/**
 * At least this long after typing or a key: a field that searches as one
 * types waits a moment first. Paid once for a run of fields filled in turn,
 * after the last of them.
 */
const TYPED_MS = 400;
/** The most one look for what a wait waits for may take. */
const PROBE_MS = 3_000;
/**
 * Steps that pay that floor: one of these next, the floor is left to it. A
 * pick or a tick between pays none, so the typing before it pays its own.
 */
const TYPING = ["type", "fill", "press"];
/** A request the action started, open longer than this, is a long poll or a stream, and does not hold the quiet. */
const STALE_REQUEST_MS = 3_000;
/** One open from before the action holds it only this long from its start. */
const EARLIER_STALE_MS = 1_000;
/**
 * An address the page asks again and again is a poll, and does not hold the
 * quiet: asked this many times in the window, counting the times it asked
 * while KOS was not at work on the page and the times since the action, not
 * those during earlier steps (a search asked once at each word typed).
 */
const POLL_REPEATS = 3;
const POLL_WINDOW_MS = 10_000;
/** Addresses whose recent requests are counted, at most. */
const PATTERNS_MAX = 200;
/** Requests ended lately that are kept, at most. */
const ENDED_MAX = 20;
/**
 * The requests a page's answer waits on: data it fetches, from any site,
 * and its own documents and scripts. Pictures, fonts, beacons, others'
 * scripts, sockets and streams never hold it. KOS for Chrome forwards only
 * these kinds (relay.ts).
 */
const AWAITED = new Set(["Document", "Script", "XHR", "Fetch"]);
const DATA = new Set(["XHR", "Fetch"]);
/** Said with a step's result when it ended with the page still bringing something in. */
const STILL_LOADING = "The page may still be loading; look again before relying on what it shows.";
/** The world KOS's own page-side scripts run in, apart from the page's. */
const WORLD = "kos-hands";
const EVAL_MS = 10_000;
/** Moves between a drag's press and its release, as a hand would make them. */
const DRAG_STEPS = 8;
const AX_MS = 20_000;
const INPUT_MS = 10_000;
/** How much of a page's text, or of a script's answer, is handed back. */
const READ_MAX = 24_000;
/** Embedded frames read into a look, at most. */
const FRAMES_MAX = 8;
/** Objects made for one call, released after it. */
const GROUP = "kos-hands";

/** How much later than the clocks' last reading a request may be heard before they are taken to have moved apart. */
const CLOCK_SLIP_MS = 2_000;

/**
 * A browser's clock read against this one: the least of when a thing was
 * heard less when the browser says it happened, so one heard late is not
 * taken for one just begun. Read afresh when a thing is heard far later
 * than that says, as after the computer slept (the clock the browser dates
 * events by stands still meanwhile) or a clock was set: kept, the old
 * reading would date every request since long ago.
 */
export class BrowserClock {
  private offset = Infinity;

  /** When by this clock a thing happened that the browser dates `at` (ms by its own), heard `now`. */
  date(at: number, now: number): number {
    const lag = now - at;
    if (lag < this.offset || lag > this.offset + CLOCK_SLIP_MS) this.offset = lag;
    return Math.min(now, at + this.offset);
  }
}

type CallArg = { value: unknown } | { objectId: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a step in flight meets once the owner has pressed Stop. */
export class Stopped extends Error {
  constructor() {
    super("stopped by the owner");
  }
}

function exceptionText(details: unknown): string {
  const d = details as { exception?: { description?: string; value?: unknown }; text?: string } | undefined;
  const first = d?.exception?.description?.split("\n")[0];
  return first ?? (d?.exception?.value !== undefined ? String(d.exception.value) : (d?.text ?? "an error"));
}

interface FrameInfo {
  id: string;
  url: string;
}

function childFrames(tree: unknown): FrameInfo[] {
  const out: FrameInfo[] = [];
  const visit = (node: unknown): void => {
    const n = node as { frame?: { id?: string; url?: string }; childFrames?: unknown[] } | undefined;
    for (const child of n?.childFrames ?? []) {
      const c = child as { frame?: { id?: string; url?: string } };
      if (c.frame?.id) out.push({ id: c.frame.id, url: c.frame.url ?? "" });
      visit(child);
    }
  };
  visit(tree);
  return out;
}

/** A url's site, near enough: its host's last two labels (a machine's name or address whole). */
function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return /^[\d.]+$|:/.test(host) || !host.includes(".") ? host : host.split(".").slice(-2).join(".");
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Where a field is: the page's origin, the origin of the frame it is in, and the document the ref came from. */
export interface FieldSpot {
  origin: string;
  frameOrigin: string;
  doc: string;
  /** What the field is, for the ask: its label, its type, and where and how its form sends. */
  field: { label: string; type: string; action?: string; method?: string };
}

/** What a secret's fill must find, as the owner approved it, and what kind of field it goes into. */
export interface FillExpect extends Omit<FieldSpot, "field"> {
  slot: SecretSlot;
}

/**
 * Why a secret was not filled. Never holds the value. `code` is what the
 * use is recorded as (refused:<code>): the ref is not of this page's last
 * look, the page changed, its origin or the field's frame is not the one
 * approved, the field is not one the secret may go into, it is in a
 * frame KOS cannot reach, a script of KOS's ran in the page, or a service
 * worker from before its site's were cleared may run it.
 */
export class SecretRefused extends Error {
  constructor(
    readonly code: "ref" | "changed" | "origin" | "field" | "unreachable" | "focus" | "scripted" | "worker",
    message: string,
  ) {
    super(message);
    this.name = "SecretRefused";
  }
}

/** Said to a script, a copy or a typing step aimed at a page holding a secret KOS filled. */
export const TAINTED =
  "a secret was filled into this page, so scripts in it, copying from or selecting a secret field, typing into one, and aiming at anything but an @ref (a selector, a text, a wait for words) are refused until a new page loads";

/** A frame's origin as KOS checks it: http or https and a host. A blank, sandboxed or data frame has none. */
const CHECKED_ORIGIN = /^https?:\/\/[^/\s]+$/;

export interface Look {
  index: PageIndex;
  /** Embedded frames that could not be read, by host. */
  unread: string[];
  /** Parts of the page closed to scripts (closed shadow roots), not read. */
  closed?: number;
}

export class Page {
  private readonly refs = new Refs();
  /** The document the refs belong to. */
  private documentId = "";
  private mainFrame = "";
  /** The site the main frame is on: its requests are the ones an action's answer waits on. */
  private site = "";
  /** When the main frame last began to load. */
  private loadStarted = 0;
  /** Each frame's world of KOS's own, by frame: undefined where none could be made. */
  private readonly worlds = new Map<string, Promise<number | undefined>>();
  /** The main frame's current document, and the lifecycle points it has reached. */
  /** The main frame's current document, the lifecycle points it has reached, and when it began by `tick` (0 for one KOS found already there). */
  private life = { loader: "", reached: new Set<string>(), at: 0 };
  /** Each frame's main-world context, by frame, while a script of KOS's is being placed: its id, its unique id and its origin. */
  private readonly contexts = new Map<string, { id: number; uniqueId: string; origin: string }>();
  private loading = false;
  /** Requests the page's answer may wait on: when each started, and the address it went to, less its query. */
  private readonly inflight = new Map<string, { at: number; pattern: string }>();
  /** Requests ended lately: when each started and ended, and its address, for giving the page time to show its answer. */
  private readonly ended: { at: number; pattern: string; end: number }[] = [];
  /** When the page last asked each address, and whether KOS was at work on the page then, for telling a poll from an answer. */
  private readonly asked = new Map<string, { at: number; idle: boolean }[]>();
  /** Calls at work on the page now. */
  private working = 0;
  /** When a message last came in on one of the page's sockets. */
  private socketAt = 0;
  /** The browser's clock, read against this one: a request is dated by the browser, so one heard late is not taken for one the action started. */
  private readonly clock = new BrowserClock();
  /** How to answer the next dialog, when a step said. */
  private answer: { accept: boolean; text?: string } | null = null;
  /** What a drag the page started would carry, while a drag of the hands' is under way. */
  private dragged: unknown;
  private readonly heard: string[] = [];
  private crashed = false;
  private prepared: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly wakers = new Set<() => void>();
  /** The owner's Stop, for the step in flight. */
  private stop: AbortSignal | undefined;
  /** Elements resolved for this call, by node, and the document they were resolved in. */
  private objects = { loader: "", ids: new Map<number, string>() };
  /** The fields of this document a secret was filled into, until it changes. */
  private taint: Taint | undefined;
  /** The main frame's address now. */
  private url = "";
  /** Addresses (less their fragment) of documents a secret was filled into: one come back to (back, forward, a reload) may hold it again, as the page restores what was typed. */
  private readonly taintedUrls = new Set<string>();
  /** Every value filled in this tab, for as long as the tab lives: a later page may echo one (a GET form's address, a confirmation). */
  private readonly filled: FilledValue[] = [];
  /** Masked pictures under way, in turn. */
  private pictures: Promise<unknown> = Promise.resolve();

  private readonly limits: PageLimits;
  private readonly now: () => number;
  private readonly gate: (signal?: AbortSignal) => Promise<boolean>;
  private readonly kin: () => Kin | undefined;
  private readonly saved: () => readonly FilledValue[];
  private readonly savedFor: (origins: readonly string[]) => readonly FilledValue[];
  private readonly evalBlocked: (origin: string) => string | undefined;
  /** Documents a script of KOS's ran in: one may have left a hook for what is filled, so none is filled there. */
  private readonly scripted: { has(loader: string): boolean; mark(loader: string): void };
  private readonly settled: () => Promise<void>;
  private readonly workerBar: (origin: string, loadedAt: number, controlled: boolean) => Promise<string | undefined>;
  private readonly tick: () => number;
  private readonly putSecret: ((put: SecretPut) => Promise<void>) | undefined;
  private readonly heldElsewhere: () => HeldElsewhere | undefined;

  constructor(
    private readonly session: Session,
    options: PageOptions = {},
  ) {
    this.limits = { ...LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.gate = options.gate ?? (async () => false);
    this.kin = options.kin ?? (() => undefined);
    this.saved = options.saved ?? (() => []);
    this.savedFor = options.savedFor ?? (() => []);
    this.evalBlocked = options.evalBlocked ?? (() => undefined);
    const scripted = new Set<string>();
    this.scripted = options.scripted ?? { has: (loader) => scripted.has(loader), mark: (loader) => void scripted.add(loader) };
    this.settled = options.settled ?? (async () => undefined);
    this.workerBar = options.workerBar ?? (async () => undefined);
    this.tick = options.tick ?? (() => performance.now());
    this.putSecret = options.putSecret;
    this.heldElsewhere = options.heldElsewhere ?? (() => undefined);
  }

  /**
   * Calls on one tab, one at a time: two at once would act on each other's
   * page. Once `signal` aborts, a call still waiting for the owner to let go
   * of the tab gives up its turn, and the next call has it.
   */
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const gated = async (): Promise<T> => {
      this.working++;
      try {
        await this.waitForOwner(signal);
        return await work();
      } finally {
        this.working--;
      }
    };
    const next = this.queue.then(gated, gated);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** While the owner has the tab, nothing; once they let go, a word that the page may have changed. A Stop ends the wait. */
  private async waitForOwner(stop = this.stop): Promise<void> {
    if (await this.guard(this.gate(stop), stop)) this.heard.push("The owner had this tab and has let go; what is on it may have changed, so look before acting on it.");
  }

  /** An event from the tab's session. */
  handle(event: CdpEvent): void {
    const p = event.params;
    switch (event.method) {
      case "Page.frameStartedLoading":
        if (p["frameId"] === this.mainFrame) {
          this.loading = true;
          this.loadStarted = this.now();
        }
        break;
      case "Page.frameStoppedLoading":
        if (p["frameId"] === this.mainFrame) this.loading = false;
        break;
      case "Page.lifecycleEvent":
        if (p["frameId"] === this.mainFrame) {
          const loader = String(p["loaderId"] ?? "");
          if (loader !== this.life.loader) this.life = { loader, reached: new Set(), at: this.tick() };
          this.life.reached.add(String(p["name"] ?? ""));
        }
        break;
      case "Page.frameNavigated": {
        const frame = p["frame"] as { id?: string; parentId?: string; url?: string } | undefined;
        if (frame?.id) this.worlds.delete(frame.id);
        if (frame?.id && !frame.parentId) {
          this.mainFrame = frame.id;
          this.site = siteOf(frame.url ?? "");
          this.url = frame.url ?? "";
        }
        break;
      }
      case "Page.navigatedWithinDocument":
        if (p["frameId"] === this.mainFrame) {
          this.url = String(p["url"] ?? "");
          // The document keeps its secret at its new address, and history keeps both.
          if (this.taint && this.taint.loader === this.life.loader) this.taintedUrls.add(urlKey(this.url));
        }
        break;
      case "Runtime.executionContextCreated": {
        const c = p["context"] as { id?: number; uniqueId?: string; origin?: string; auxData?: { isDefault?: boolean; frameId?: string } } | undefined;
        if (c?.auxData?.isDefault && c.auxData.frameId && typeof c.id === "number") this.contexts.set(c.auxData.frameId, { id: c.id, uniqueId: c.uniqueId ?? "", origin: c.origin ?? "" });
        break;
      }
      case "Page.javascriptDialogOpening":
        this.onDialog(String(p["type"] ?? "alert"), String(p["message"] ?? ""));
        break;
      // The page began a drag of its own: what it would carry, for the drop.
      case "Input.dragIntercepted":
        this.dragged = p["data"];
        break;
      case "Network.requestWillBeSent": {
        const url = (p["request"] as { url?: string } | undefined)?.url ?? "";
        const type = String(p["type"] ?? "");
        if (DATA.has(type) || (AWAITED.has(type) && siteOf(url) === this.site)) this.requested(String(p["requestId"]), url, p["wallTime"] ?? p["timestamp"]);
        break;
      }
      case "Network.webSocketFrameReceived":
        this.socketAt = this.now();
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const id = String(p["requestId"]);
        const request = this.inflight.get(id);
        if (!request) break;
        this.inflight.delete(id);
        this.ended.push({ ...request, end: this.now() });
        if (this.ended.length > ENDED_MAX) this.ended.shift();
        break;
      }
      case "Inspector.targetCrashed":
        this.crashed = true;
        break;
      default:
        return;
    }
    for (const wake of [...this.wakers]) wake();
  }

  /** What happened on the page that the agent should hear: dialogs answered, a crash recovered. */
  takeNotes(): string[] {
    return this.heard.splice(0).map((note) => this.clean(note));
  }

  /** The tab ready to be driven, and well: a crashed page is loaded again. */
  async ready(): Promise<void> {
    this.prepared ??= this.prepare().catch((err: unknown) => {
      this.prepared = null;
      throw err;
    });
    await this.prepared;
    if (this.crashed) {
      this.crashed = false;
      const [before, since] = [this.life.loader, this.now()];
      await this.send("Page.reload", {});
      await this.settle(before, since);
      this.heard.push("The tab had crashed, and was loaded again.");
    }
  }

  private async prepare(): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await this.send("Network.enable");
    await this.send("Inspector.enable").catch(() => undefined);
    const tree = await this.send("Page.getFrameTree");
    const frame = (tree["frameTree"] as { frame?: { id?: string; loaderId?: string; url?: string } } | undefined)?.frame;
    this.mainFrame = frame?.id ?? "";
    this.site = siteOf(frame?.url ?? "");
    this.url = frame?.url ?? "";
    // A page already there when KOS came to it: what it has reached is asked, not heard.
    const state = await this.value<string>("document.readyState").catch(() => "complete");
    const reached = state === "complete" ? ["DOMContentLoaded", "load"] : state === "interactive" ? ["DOMContentLoaded"] : [];
    this.life = { loader: frame?.loaderId ?? "", reached: new Set(reached), at: 0 };
    this.documentId = this.life.loader;
  }

  // Going places.

  /**
   * To a url, until the page can be read (or has loaded in full). A page
   * still loading at the deadline is handed back as it is, said to be so.
   */
  async goto(address: string, until: "dom" | "load" = "dom"): Promise<{ stillLoading: boolean }> {
    // Every way here is the web's: a javascript: address would run in the page, a secret's among them.
    const url = urlFor(address);
    if (isDataUrl(url) && this.holding()) throw new Error(`a data: address is refused: ${TAINTED}`);
    let answer: Record<string, unknown>;
    try {
      answer = await this.send("Page.navigate", { url }, this.limits.domMs);
    } catch (err) {
      if (err instanceof Error && err.message.endsWith("timed out")) return { stillLoading: true };
      throw err;
    }
    const error = typeof answer["errorText"] === "string" ? answer["errorText"] : "";
    if (error === "net::ERR_ABORTED") throw new Error(`${url} did not open as a page; if it is a file, it downloaded, and lands in Files`);
    if (error) throw new Error(`could not open ${url}: ${error}`);
    const loader = typeof answer["loaderId"] === "string" ? answer["loaderId"] : "";
    // No new document: the url only moved within the page.
    if (!loader) return { stillLoading: false };
    const want = until === "load" ? "load" : "DOMContentLoaded";
    const reached = await this.waitUntil(() => this.life.loader === loader && this.life.reached.has(want), until === "load" ? this.limits.loadMs : this.limits.domMs);
    if (reached) await this.settle(loader, this.now(), true);
    return { stillLoading: !reached };
  }

  /** Back, forward or reload, as the browser's buttons do. False when there is no page to go to. */
  async go(where: "back" | "forward" | "reload"): Promise<boolean> {
    const [before, since] = [this.life.loader, this.now()];
    if (where === "reload") {
      await this.send("Page.reload", {});
    } else {
      const history = await this.send("Page.getNavigationHistory");
      const entries = (history["entries"] as { id: number }[] | undefined) ?? [];
      const at = typeof history["currentIndex"] === "number" ? history["currentIndex"] : -1;
      const entry = entries[at + (where === "back" ? -1 : 1)];
      if (!entry) return false;
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    }
    await this.settle(before, since);
    return true;
  }

  // Seeing.

  /** Where the tab is and what the page is called. */
  async whereAmI(): Promise<{ url: string; title: string }> {
    const where = await this.value<{ url: string; title: string }>(`(${inpage.whereAmI.toString()})()`, 3_000).catch(() => ({ url: "", title: "" }));
    return { url: this.clean(where.url), title: this.clean(where.title) };
  }

  /** What can be acted on, each with its ref; `scope` limits it to the part of the page a CSS selector names. */
  async index(scope?: string): Promise<Look> {
    this.freshDocument();
    if (scope) this.refsOnly(`looking within ${scope}`);
    const found = await this.found(this.mainFrame, scope ?? null, { left: FRAMES_MAX });
    if (found) return { index: this.cleanIndex(indexOf(found.controls, found.total, this.refs)), unread: found.unread, ...(found.closed ? { closed: found.closed } : {}) };
    // No world of KOS's own on this tab (a KOS for Chrome from before there was one): the tree it was read from before.
    const { nodes, unread } = await this.nodes(scope);
    const { controls, total } = controlsOf(nodes);
    return { index: this.cleanIndex(indexOf(controls, total, this.refs)), unread };
  }

  /** The whole page as an outline, each element with its ref. */
  async tree(scope?: string): Promise<{ text: string; cut: boolean; unread: string[] }> {
    if (scope) this.refsOnly(`looking within ${scope}`);
    const { nodes, unread } = await this.nodes(scope);
    const tree = treeOf(nodes, this.refs);
    return { ...tree, text: this.clean(tree.text), unread };
  }

  /** The page's words, or the words of what a selector names, with the links among them. */
  async read(selector?: string): Promise<string> {
    if (selector) this.refsOnly(`reading ${selector}`);
    const got = await this.value<{ text: string; links: { text: string; href: string }[]; matched: number } | null>(
      `(${inpage.readPage.toString()})(${JSON.stringify(selector ?? null)})`,
    );
    if (!got) throw new Error(selector ? `nothing on the page matches ${selector}` : "the page has nothing to read");
    const text = got.text.length > READ_MAX ? `${got.text.slice(0, READ_MAX)}\n(cut at ${READ_MAX} characters; a selector reads one part)` : got.text;
    const links = got.links.length ? `\n\nLinks:\n${got.links.map((l) => `- ${l.text}: ${l.href}`).join("\n")}` : "";
    const many = selector && got.matched > 1 ? `(${got.matched} elements match ${selector})\n` : "";
    return this.clean(`${many}${text || "(no text)"}${links}`);
  }

  /** A script run in the page, top-level await allowed; its answer as text. */
  async evaluate(code: string): Promise<string> {
    // A script could read a secret straight out of its field.
    if (this.holding()) throw new Error(`browser.eval is refused: ${TAINTED}`);
    // On a site a secret may be filled on, a script could read a copy the site keeps, or wait for the next fill.
    const before = await this.document();
    const refuse = (origin: string, why: string): never => {
      throw new Error(`browser.eval is refused on ${origin}: ${why}, so no script of KOS's runs in its pages. Looking, reading, acting with steps and browser.handoff still work here.`);
    };
    for (const { origin } of before.frames) {
      const why = /^https?:/i.test(origin) ? this.evalBlocked(origin) : undefined;
      if (why) refuse(origin, why);
    }
    // Each frame's own context says its origin: one about:blank, a popup's among them, has its opener's, though its frame says none.
    const contexts = await this.mainWorlds();
    const main = contexts.get(before.frame);
    if (!main) throw new Error("browser.eval found no page to run in (it may be loading); look at the page again");
    for (const { id, origin } of before.frames) {
      if (/^https?:/i.test(origin)) continue;
      const own = contexts.get(id)?.origin ?? origin;
      const why = this.evalBlocked(own) ?? this.evalBlocked(origin);
      if (why) refuse(own, why);
    }
    this.scripted.mark(before.loader);
    // Run in the context checked, which no later page can host; and only while it is still on the origin checked.
    const guard = /^https?:/i.test(main.origin) ? `if (self.origin !== ${JSON.stringify(main.origin)}) throw new Error("the page moved to another site before the script ran");\n` : "";
    const answer = await this.send(
      "Runtime.evaluate",
      { expression: guard + code, uniqueContextId: main.uniqueId, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true, timeout: EVAL_MS, objectGroup: GROUP },
      EVAL_MS + 2_000,
    );
    const after = await this.document();
    if (after.loader !== before.loader) {
      // The script may have run on the next document too, or reached it: that one takes no fill either, and what came back is not said.
      this.scripted.mark(after.loader);
      throw new Error("the page loaded another document while the script ran, so its answer is withheld; look at the page again");
    }
    if (answer["exceptionDetails"]) throw new Error(`the script threw: ${this.clean(exceptionText(answer["exceptionDetails"]))}`);
    const result = answer["result"] as { type?: string; value?: unknown; description?: string } | undefined;
    if (!result || result.type === "undefined") return "undefined";
    // Cleaned whole, then cut: a value cut in half would not be found.
    const out = this.clean(typeof result.value === "string" ? result.value : result.value !== undefined ? JSON.stringify(result.value, null, 2) : (result.description ?? ""));
    return out.length > READ_MAX ? `${out.slice(0, READ_MAX)}\n(cut at ${READ_MAX} characters)` : out;
  }

  // Acting.

  /**
   * One step on the page; what was done, in words. Once `signal` aborts, the
   * step ends where it is: a wait is woken, a command still out is no longer
   * waited for, and no further one is sent. It throws Stopped. `next` is
   * the step to come in the same run, none at its end.
   */
  async step(step: Step, signal?: AbortSignal, next?: Step): Promise<string> {
    this.stop = signal;
    try {
      return await this.perform(step, next && TYPING.some((k) => k in next) ? 0 : TYPED_MS);
    } finally {
      this.stop = undefined;
    }
  }

  /** `typed` is the least time given the page after typing or a key. */
  private async perform(step: Step, typed: number): Promise<string> {
    await this.waitForOwner();
    if ("open" in step) {
      const went = await this.goto(step.open);
      return `opened ${step.open}${went.stillLoading ? " (still loading)" : ""}`;
    }
    if ("go" in step) return (await this.go(step.go)) ? `went ${step.go}` : `there was nowhere to go ${step.go}`;
    if ("click" in step) {
      await this.acting(async () => this.click(await this.element(step.click), step.click));
      return `clicked ${step.click}`;
    }
    if ("dblclick" in step) {
      await this.acting(async () => this.click(await this.element(step.dblclick), step.dblclick, { button: "left", count: 2 }));
      return `double-clicked ${step.dblclick}`;
    }
    if ("rightclick" in step) {
      await this.acting(async () => this.click(await this.element(step.rightclick), step.rightclick, { button: "right", count: 1 }));
      return `right-clicked ${step.rightclick}`;
    }
    if ("drag" in step) {
      // A drag carries what it picks up, a secret's text among it.
      if (this.tainted()) throw new Error(`dragging is refused: ${TAINTED}`);
      const { from, to } = step.drag;
      await this.acting(async () => this.drag(await this.element(from), from, await this.element(to), to));
      return `dragged ${from} to ${to}`;
    }
    if ("hover" in step) {
      const at = await this.point(await this.element(step.hover), step.hover);
      await this.mouse("mouseMoved", at);
      await this.pause(150);
      return `hovered over ${step.hover}`;
    }
    if ("fill" in step) {
      await this.acting(async () => this.write(await this.element(step.fill.target), step.fill.target, step.fill.text, true), typed);
      return `filled ${step.fill.target}`;
    }
    if ("type" in step) {
      await this.acting(async () => this.write(await this.element(step.type.target), step.type.target, step.type.text, false), typed);
      return `typed into ${step.type.target}`;
    }
    if ("press" in step) {
      const press = parseKeys(step.press);
      if (await this.copiesSecret(press)) throw new Error(`${step.press} is refused: ${TAINTED}`);
      await this.acting(() => this.key(press), typed);
      return `pressed ${step.press}`;
    }
    if ("select" in step) {
      const picked = await this.choose(await this.element(step.select.target), step.select.target, step.select.values);
      return `picked ${picked.join(", ")} in ${step.select.target}`;
    }
    if ("check" in step || "uncheck" in step) {
      const want = "check" in step;
      const target = "check" in step ? step.check : step.uncheck;
      return this.toggle(await this.element(target), target, want);
    }
    if ("scroll" in step) return this.scroll(step.scroll);
    if ("wait" in step) return this.wait(step.wait);
    this.answer = step.dialog;
    return `will ${step.dialog.accept ? "accept" : "dismiss"} the next dialog`;
  }

  // Secrets.

  /**
   * Where the element a ref names is: the page's origin, the origin of the
   * frame the element sits in, and the document the ref belongs to. Read
   * from the browser (its DOM tree and its frames), never from the page's
   * scripts. A ref from an earlier page, or an element in a frame of another
   * process, which KOS cannot reach, is refused.
   */
  async fieldSpot(ref: string): Promise<FieldSpot> {
    const node = this.refNode(ref);
    const frame = await this.frameOf(node);
    const frames = await this.frameTree();
    const field = await this.callIn<FieldSpot["field"]>(frame, node, inpage.fieldInfo);
    return { origin: frames.get(this.mainFrame)?.origin ?? "", frameOrigin: frames.get(frame)?.origin ?? "", doc: this.life.loader, field };
  }

  /**
   * A secret into the field a ref names, as approved: the ref from this
   * document's last look, the page and the field's frame on the origins in
   * `expect`, each frame around the field drawn and in view, and the field
   * one `expect.slot` may go into (inpage.fillable). The value is set on
   * that node itself, through the native setter and the events typing
   * raises, so it cannot land wherever the focus is; only a page that
   * refuses that gets real typing, and then only while the field has the
   * keyboard before and after, or it is refused as `focus`. It is checked
   * to hold the value without reading it back. A secret's field is marked,
   * so the page is tainted until its document changes (see TAINTED), and
   * the value is masked in what KOS reads and pictures of the tab from
   * then on. Nothing thrown holds the value.
   */
  async fillSecret(ref: string, value: string, expect: FillExpect): Promise<void> {
    const node = this.refNode(ref);
    await this.settled();
    if (this.life.loader !== expect.doc) throw new SecretRefused("changed", "the page changed since you approved; look again and ask again");
    if (this.scripted.has(this.life.loader)) throw new SecretRefused("scripted", "a script of yours ran in this page (browser.eval) and could catch what is filled; open the page afresh, look again and ask again");
    const frame = await this.frameOf(node);
    const frames = await this.frameTree();
    const origin = frames.get(this.mainFrame)?.origin ?? "";
    const frameOrigin = frames.get(frame)?.origin ?? "";
    if (origin !== expect.origin) throw new SecretRefused("origin", `the page is on ${origin || "no site"} now, not ${expect.origin}, which was approved`);
    if (frameOrigin !== expect.frameOrigin || !CHECKED_ORIGIN.test(frameOrigin)) throw new SecretRefused("origin", `${ref} is in a frame from ${frameOrigin || "no site"}, not ${expect.frameOrigin}, which was approved`);
    // A service worker from before its site was cleared may still run the page, and catch what it sends.
    const controlled = await this.callIn<boolean>(frame, node, inpage.workerControlled);
    for (const at of new Set([origin, frameOrigin])) {
      const why = await this.workerBar(at, this.life.at, controlled);
      if (why) throw new SecretRefused("worker", `${why}; open the page afresh, look again and ask again`);
    }
    // A field in a frame the page hides (a honeypot) is as hidden as a field that is.
    for (let at = frame; at !== this.mainFrame; ) {
      const parent = frames.get(at)?.parent;
      const owner = (await this.send("DOM.getFrameOwner", { frameId: at }))["backendNodeId"];
      if (!parent || typeof owner !== "number") throw new SecretRefused("unreachable", `${ref} is in a frame KOS cannot reach`);
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner }).catch(() => undefined);
      if (!(await this.callIn<boolean>(parent, owner, inpage.frameShown))) throw new SecretRefused("field", `${ref} is in a frame that is hidden or out of view`);
      at = parent;
    }
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node }).catch(() => undefined);
    const secret = isSecretSlot(expect.slot);
    const why = await this.callIn<string>(frame, node, inpage.fillable, [{ value: expect.slot }, { value: secret }]);
    if (why) throw new SecretRefused("field", `${ref}: ${why}`);
    const digits = isDigitSlot(expect.slot);
    const args: CallArg[] = [{ value }, { value: digits }];
    // Marked before it goes in: a field that took part of it holds a secret too, and so may the page.
    if (secret) {
      await this.callIn(frame, node, inpage.taint);
      if (this.taint?.loader !== this.life.loader) this.taint = { loader: this.life.loader, nodes: new Map() };
      this.taint.nodes.set(node, frame);
      this.taintedUrls.add(urlKey(this.url));
      for (const values of [this.filled, this.kin()?.values]) if (values) keepFilled(values, { text: value, digits, origins: [...new Set([origin, frameOrigin])] });
    }
    // A browser that puts it in itself checks all this again on its side, and the field's holding it.
    const put = this.putSecret;
    if (put) return this.acting(() => put({ node, frame, doc: this.life.loader, origin, frameOrigin, slot: expect.slot, value }), TYPED_MS);
    let held = false;
    await this.acting(async () => {
      held = await this.callIn<boolean>(frame, node, inpage.putValue, args);
      if (held) return;
      // The page wants keys: typed only while the field has the keyboard, checked on both sides of the typing.
      await this.send("DOM.focus", { backendNodeId: node });
      await this.callIn(frame, node, inpage.selectAll);
      if (!(await this.callIn<boolean>(frame, node, inpage.hasKeyboard))) throw new SecretRefused("focus", `${ref} would not keep the keyboard (the page moved it elsewhere); nothing was typed`);
      await this.send("Input.insertText", { text: value }, INPUT_MS);
      if (!(await this.callIn<boolean>(frame, node, inpage.hasKeyboard))) throw new SecretRefused("focus", `the keyboard moved off ${ref} while it was typed into; look at the page before anything else`);
      held = await this.callIn<boolean>(frame, node, inpage.holds, args);
    }, TYPED_MS);
    if (!held) throw new SecretRefused("field", `${ref} did not take it as given (it may format or limit what goes in); look to see what it holds`);
  }

  /**
   * A picture of a page that may show a secret (one filled in this tab or
   * its kin on a frame's origin, or a saved one for its site), or of a page
   * holding one: `shoot` takes it, as a PNG when it is to be painted over,
   * and every text box and every place the page echoes such a value is
   * painted out of it here, the page itself never changed (boxes.ts). A page
   * with none is pictured as it is. Answers a JPEG at `quality`; throws when it cannot
   * mask, so no picture is taken rather than one that shows a secret.
   */
  masked(shoot: (format: "png" | "jpeg") => Promise<PageShot | undefined>, quality: number): Promise<string | undefined> {
    // One at a time: the page is measured on both sides of its picture.
    const next = this.pictures.then(() => this.maskedNow(shoot, quality));
    this.pictures = next.catch(() => undefined);
    return next;
  }

  private async maskedNow(shoot: (format: "png" | "jpeg") => Promise<PageShot | undefined>, quality: number): Promise<string | undefined> {
    const held = this.holdsSecret();
    // Only what a frame may be shown, by its own origin: no frame is sent another's values to find.
    const measure = (): Promise<SecretBoxes | undefined> =>
      boxesOf((method, params) => this.send(method, params, AX_MS), (frame) => this.world(frame), held, (origin) => echoPatterns(this.pageValues([origin]), 1));
    const first = await measure();
    if (!first) return (await shoot("jpeg"))?.data;
    const { shot, boxes } = await steadyShot(measure, () => shoot("png"), first);
    if (!shot) return undefined;
    if (!boxes) return paintedJpeg(shot.data, () => [], quality);
    // The picture is clipped to the size it says from the viewport's corner: a page zoomed in, or of no size known, is not placed on it.
    if (boxes.view.scale !== 1 || !shot.width || !shot.height) throw new Error("the page could not be masked, so it is not pictured");
    return paintedJpeg(shot.data, (image) => pixelBoxes(boxes, image, shot), quality);
  }

  /** The secrets filled into this document, if any: a new document has none. */
  private tainted(): Taint | undefined {
    if (this.taint && this.taint.loader !== this.life.loader) this.taint = undefined;
    if (this.taint) return this.taint;
    // A document a secret was in, come back to, or one the browser says was filled before this Page: which fields hold it is not known, so the whole page is held to.
    const elsewhere = this.heldElsewhere();
    const before = elsewhere !== undefined && ((elsewhere.loader !== "" && elsewhere.loader === this.life.loader) || elsewhere.urls.includes(urlKey(this.url)));
    return before || this.taintedUrls.has(urlKey(this.url)) ? { loader: this.life.loader, nodes: new Map() } : undefined;
  }

  /** Whether a field may hold a secret KOS filled: one it filled, or any on a page a secret was in come back to, where which is not known. */
  private heldField(node: number): boolean {
    const taint = this.tainted();
    return taint !== undefined && (taint.nodes.size === 0 || taint.nodes.has(node));
  }

  /** Whether this tab holds a secret KOS filled in its page now. */
  holdsSecret(): boolean {
    return this.tainted() !== undefined;
  }

  /** Whether a secret KOS filled is in this page now, where a script could reach it. */
  private holding(): boolean {
    return this.holdsSecret() || this.kin()?.holding() === true;
  }

  /** Every value filled in this tab or any it shares its secrets with, and every saved one: what is cleaned out of what KOS reads back, in the host. */
  private values(): FilledValue[] {
    return merged(this.filled, this.kin()?.values ?? [], this.saved());
  }

  /** The values a page on these origins may be sent to mask: those filled in this tab or its kin on one of them, and the saved ones for its site. */
  private pageValues(origins: readonly string[]): FilledValue[] {
    const here = (v: FilledValue): boolean => v.origins === undefined || v.origins.some((o) => origins.includes(o));
    return merged(this.filled.filter(here), (this.kin()?.values ?? []).filter(here), this.savedFor(origins));
  }

  /** The main frame's document as one answer of the browser has it: its frame, its loader, and every frame with its origin. */
  private async document(): Promise<{ frame: string; loader: string; frames: { id: string; origin: string }[] }> {
    type FrameTree = { frame?: { id?: string; loaderId?: string; securityOrigin?: string }; childFrames?: FrameTree[] };
    const tree = (await this.send("Page.getFrameTree"))["frameTree"] as FrameTree | undefined;
    const frames: { id: string; origin: string }[] = [];
    const walk = (t: FrameTree | undefined): void => {
      if (!t) return;
      frames.push({ id: t.frame?.id ?? "", origin: t.frame?.securityOrigin ?? "" });
      for (const child of t.childFrames ?? []) walk(child);
    };
    walk(tree);
    return { frame: tree?.frame?.id ?? "", loader: tree?.frame?.loaderId ?? "", frames };
  }

  /** Each frame's main-world context, as the browser reports them when asked: Runtime is on only for as long as it takes to hear them. */
  private async mainWorlds(): Promise<Map<string, { id: number; uniqueId: string; origin: string }>> {
    this.contexts.clear();
    try {
      // The contexts there now are reported before the answer.
      await this.send("Runtime.enable");
    } finally {
      await this.send("Runtime.disable").catch(() => undefined);
    }
    return new Map(this.contexts);
  }

  /** Text read from the page with every secret filled into it said as hidden, where the page echoes one. */
  private clean(text: string): string {
    const values = this.values();
    return values.length ? unechoed(text, values) : text;
  }

  private cleanIndex(index: PageIndex): PageIndex {
    return this.values().length ? { ...index, lines: index.lines.map((line) => this.clean(line)) } : index;
  }

  /** While the page holds a secret, only a ref names what to act on or read: a selector or a text could find the secret by guessing at it. */
  private refsOnly(what: string): void {
    if (this.tainted()) throw new Error(`${what} is refused: ${TAINTED}`);
  }

  /**
   * Whether a key would carry a secret out of its field: a copy, a cut, a
   * select-all or a paste key (keys.copyKey), or any editing command, aimed
   * at a field holding one (the one with the keyboard in a frame KOS
   * filled). On a page a secret was in come back to, no field is known, so
   * any of them anywhere.
   */
  private async copiesSecret(press: KeyPress): Promise<boolean> {
    const taint = this.tainted();
    if (!taint || !(copyKey(press.key, press.code, press.keyCode, press.modifiers, press.commands) || press.commands?.length)) return false;
    if (taint.nodes.size === 0) return true;
    for (const frame of new Set(taint.nodes.values())) {
      const context = await this.world(frame);
      // A frame KOS cannot look into is taken to have the field focused.
      if (context === undefined) return true;
      const got = await this.send("Runtime.evaluate", { expression: `(${inpage.focusedHere.toString()})()`, contextId: context, objectGroup: GROUP });
      const objectId = (got["result"] as { objectId?: string } | undefined)?.objectId;
      if (objectId && taint.nodes.has(await this.backendOf(objectId))) return true;
    }
    return false;
  }

  /** The element a ref from this document's last look names. */
  private refNode(ref: string): number {
    this.freshDocument();
    const id = /^@?(e\d+)$/.exec(ref)?.[1];
    const node = id ? this.refs.nodeOf(id) : undefined;
    if (node === undefined) throw new SecretRefused("ref", `${ref} is not a ref from the last look at this page; look again for the field's ref`);
    return node;
  }

  /** The frame an element is in, by the browser's own tree of the page and its frames. One in a frame of another process is not in it. */
  private async frameOf(node: number): Promise<string> {
    type DomNode = { backendNodeId?: number; frameId?: string; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };
    const doc = await this.send("DOM.getDocument", { depth: -1, pierce: true }, AX_MS);
    const find = (n: DomNode | undefined, frame: string): string | undefined => {
      if (!n) return undefined;
      if (n.backendNodeId === node) return frame;
      for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
        const found = find(child, frame);
        if (found) return found;
      }
      return n.contentDocument && n.frameId ? find(n.contentDocument, n.frameId) : undefined;
    };
    const frame = find(doc["root"] as DomNode | undefined, this.mainFrame);
    if (!frame) throw new SecretRefused("unreachable", "the field is in a frame KOS cannot reach (another process, as many payment frames are); hand the tab to the owner with browser.handoff");
    return frame;
  }

  /** Each frame of the page: its origin, as the browser holds it, and its parent. */
  private async frameTree(): Promise<Map<string, { origin: string; parent?: string }>> {
    type FrameTree = { frame?: { id?: string; securityOrigin?: string }; childFrames?: FrameTree[] };
    const out = new Map<string, { origin: string; parent?: string }>();
    const walk = (t: FrameTree | undefined, parent?: string): void => {
      const id = t?.frame?.id;
      if (!id) return;
      out.set(id, { origin: t.frame?.securityOrigin ?? "", ...(parent ? { parent } : {}) });
      for (const child of t.childFrames ?? []) walk(child, id);
    };
    walk((await this.send("Page.getFrameTree"))["frameTree"] as FrameTree | undefined);
    return out;
  }

  /** A page-side function run on an element in its frame's world of KOS's own, its answer by value. */
  private async callIn<T>(frame: string, node: number, fn: (this: Element, ...args: never[]) => unknown, args: CallArg[] = []): Promise<T> {
    const context = await this.world(frame);
    if (context === undefined) throw new SecretRefused("unreachable", "KOS cannot look into the frame the field is in");
    const resolved = await this.send("DOM.resolveNode", { backendNodeId: node, executionContextId: context, objectGroup: GROUP });
    const objectId = (resolved["object"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new SecretRefused("changed", "the field is gone from the page (it changed); take a fresh look");
    const answer = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn.toString(), arguments: args, returnByValue: true, awaitPromise: true }, EVAL_MS);
    // Not the page's words: a script's error could name what it was given.
    if (answer["exceptionDetails"]) throw new SecretRefused("field", "the field could not be checked");
    return (answer["result"] as { value?: T } | undefined)?.value as T;
  }

  /** Objects made for the last call let go of, so a long session does not hold the page's memory. */
  async release(): Promise<void> {
    this.objects.ids.clear();
    await this.session.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
  }

  /** An action, then the page given time to answer it; `floor` is the least of that. */
  private async acting(action: () => Promise<void>, floor = 0): Promise<void> {
    const [before, since] = [this.life.loader, this.now()];
    await action();
    await this.settle(before, since, false, floor);
  }

  /**
   * Until the page has answered what was just done to it: a navigation the
   * action started has reached DOMContentLoaded, then the document has gone
   * still, no request it waits on is open, no socket message has just come
   * and the page has had a moment to draw what a request the action started
   * brought, or the most worth waiting has gone: longer while a request the
   * action started is still coming, and long enough after one ends to draw
   * it. A step that ends with one still open is said to have. `before` is
   * the document the action was done on, and `since` when; `navigated` says
   * a navigation was already waited for; `floor` is the least time given.
   */
  private async settle(before: string, since: number, navigated = false, floor = 0): Promise<void> {
    const moving = (): boolean => !navigated && (this.life.loader !== before || (this.loading && this.loadStarted >= since));
    let start = this.now();
    // An answer that lands as the busy wait runs out still has its time to be drawn, and its quiet after.
    const end = (): number => {
      const answered = this.answered(since);
      const busy = start + (this.requesting(since) === "started" ? SETTLE_BUSY_MS : SETTLE_MAX_MS);
      return Math.max(busy, Math.min(answered, start + SETTLE_BUSY_MS) + ANSWERED_MS + DOM_QUIET_MS);
    };
    // What is left of the time the page has to draw an answer it brought.
    const drawing = (): number => this.answered(since) + ANSWERED_MS - this.now();
    // Counted from the action at first; after a request or a socket message, from it.
    let grace = Math.max(DOM_QUIET_MS, floor);
    for (;;) {
      if (moving()) {
        navigated = true;
        await this.waitUntil(() => (this.life.loader !== before ? this.life.reached.has("DOMContentLoaded") : !this.loading), SETTLE_NAV_MS);
        start = this.now();
        grace = DOM_QUIET_MS;
      }
      const left = end() - this.now();
      if (left <= 0) {
        if (this.requesting(since) === "started" && !this.heard.includes(STILL_LOADING)) this.heard.push(STILL_LOADING);
        return;
      }
      const socket = this.socketAt;
      const still = await this.domQuiet(grace, left);
      if (moving()) continue;
      if (!this.requesting(since)) {
        if (still && this.socketAt === socket && drawing() <= 0) return;
        if (this.socketAt !== socket) grace = ANSWER_MS;
        if (drawing() > 0) grace = drawing();
        continue;
      }
      await this.waitUntil(() => !this.requesting(since) || moving(), Math.max(0, end() - this.now()));
      grace = Math.max(ANSWER_MS, drawing());
    }
  }

  /**
   * When a request the action `since` started last ended, as an answer the
   * page will draw: not a long one, and to an address the page had not
   * asked lately. One it had (a poll, a search asked again at each word) is
   * waited out as before, with no time added to draw it. -Infinity if none.
   */
  private answered(since: number): number {
    let last = -Infinity;
    for (const { at, pattern, end } of this.ended) {
      if (at < since || end - at >= STALE_REQUEST_MS || end <= last) continue;
      if (!(this.asked.get(pattern) ?? []).some((a) => a.at < at && at - a.at < POLL_WINDOW_MS)) last = end;
    }
    return last;
  }

  /** A request the page's answer may wait on began, `sent` in seconds by the browser's clock when it says. */
  private requested(id: string, url: string, sent: unknown): void {
    const t = typeof sent === "number" && Number.isFinite(sent) ? this.clock.date(sent * 1000, this.now()) : this.now();
    const pattern = url.replace(/[?#].*$/, "");
    this.inflight.set(id, { at: t, pattern });
    const times = (this.asked.get(pattern) ?? []).filter((a) => t - a.at < POLL_WINDOW_MS);
    times.push({ at: t, idle: this.working === 0 });
    this.asked.delete(pattern);
    this.asked.set(pattern, times);
    if (this.asked.size > PATTERNS_MAX) this.asked.delete(this.asked.keys().next().value!);
  }

  /**
   * Whether a request the page's answer waits on is open: one the action
   * `since` started ("started"), one from just before it (true), or none.
   * Not one open so long that it is a long poll or a stream, nor one to an
   * address the page asks again and again (a poll): told apart by age and
   * repetition, not by whose site it is.
   */
  private requesting(since: number): "started" | boolean {
    const t = this.now();
    let open: "started" | boolean = false;
    for (const [id, { at, pattern }] of this.inflight) {
      if (t - at > 60_000) {
        this.inflight.delete(id);
        continue;
      }
      if (t - at >= (at >= since ? STALE_REQUEST_MS : EARLIER_STALE_MS) || this.polled(pattern, since, t)) continue;
      if (at >= since) return "started";
      open = true;
    }
    return open;
  }

  /** Whether the page asks an address again and again: while KOS was not at work on it, and since the action. */
  private polled(pattern: string, since: number, t: number): boolean {
    const times = this.asked.get(pattern) ?? [];
    return times.filter((a) => t - a.at < POLL_WINDOW_MS && (a.idle || a.at >= since)).length >= POLL_REPEATS;
  }

  /** Until the main document has not changed for a moment and `grace` has gone, or `ms` has; true when it went still. */
  private async domQuiet(grace: number, ms: number): Promise<boolean> {
    const context = await this.world(this.mainFrame);
    if (context === undefined) {
      await this.pause(Math.min(grace, ms));
      return true;
    }
    const wait = Math.max(1, Math.round(ms));
    try {
      const got = await this.send(
        "Runtime.evaluate",
        { expression: `(${inpage.domQuiet.toString()})(${DOM_QUIET_MS}, ${grace}, ${wait})`, contextId: context, awaitPromise: true, returnByValue: true },
        wait + EVAL_MS,
      );
      return (got["result"] as { value?: unknown } | undefined)?.value === true;
    } catch (err) {
      if (err instanceof Stopped) throw err;
      // The document went (a navigation) or its world did: made again when next asked for.
      this.worlds.delete(this.mainFrame);
      await this.pause(Math.min(50, ms));
      return false;
    }
  }

  /**
   * A frame's world of KOS's own, made once for each document it holds.
   * Undefined where the browser will not make one (a KOS for Chrome from
   * before there was one), which is kept; any other failure, a Stop among
   * them, is not, so the next call asks again.
   */
  private world(frame: string): Promise<number | undefined> {
    let made = this.worlds.get(frame);
    if (!made) {
      made = this.send("Page.createIsolatedWorld", { frameId: frame, worldName: WORLD }).then(
        (r) => (typeof r["executionContextId"] === "number" ? r["executionContextId"] : undefined),
        (err: unknown) => {
          if ((err as { code?: unknown }).code === "method") return undefined;
          if (this.worlds.get(frame) === made) this.worlds.delete(frame);
          if (err instanceof Stopped) throw err;
          return undefined;
        },
      );
      this.worlds.set(frame, made);
    }
    return made;
  }

  private async click(node: number, label: string, how: { button: "left" | "right"; count: number } = { button: "left", count: 1 }): Promise<void> {
    const at = await this.reachable(node, label);
    const presses = Array.from({ length: how.count }, (_, i) => [
      this.mouseCall("mousePressed", at, { button: how.button, clickCount: i + 1 }),
      this.mouseCall("mouseReleased", at, { button: how.button, clickCount: i + 1 }),
    ]).flat();
    await this.all([this.mouseCall("mouseMoved", at), ...presses]);
  }

  /**
   * Press on one element, move to another and let go: a slider, a card into
   * a column, a file onto a drop zone. A page that uses the browser's own
   * drag and drop gets it from the drag Chrome would have started, which
   * synthetic pointer moves alone never start.
   */
  private async drag(fromNode: number, from: string, toNode: number, to: string): Promise<void> {
    const a = await this.reachable(fromNode, from);
    const b = await this.point(toNode, to);
    this.dragged = undefined;
    await this.send("Input.setInterceptDrags", { enabled: true }).catch(() => undefined);
    let held: { x: number; y: number } | undefined;
    try {
      await this.mouse("mouseMoved", a);
      held = a;
      await this.mouse("mousePressed", a, { button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= DRAG_STEPS; i++) {
        const t = i / DRAG_STEPS;
        held = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        await this.mouse("mouseMoved", held, { button: "left", buttons: 1 });
        await this.pause(16);
      }
      if (this.dragged) {
        for (const type of ["dragEnter", "dragOver", "drop"]) await this.send("Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: this.dragged, modifiers: 0 }, INPUT_MS);
      }
      await this.mouse("mouseReleased", b, { button: "left", clickCount: 1 });
      held = undefined;
    } finally {
      this.dragged = undefined;
      // Cut short between the press and the release (a Stop, a failure), the button is let go of where the pointer is, not left held on the page.
      if (held) {
        const letGo = this.mouseCall("mouseReleased", held, { button: "left", clickCount: 1 });
        await this.session.send(letGo.method, letGo.params, INPUT_MS).catch(() => undefined);
      }
      await this.session.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
    }
  }

  /** Text into a field: in place of what is there, or after it. A field that ignores typing is set directly. */
  private async write(node: number, label: string, text: string, replace: boolean): Promise<void> {
    const field = (await this.nodeVia(node, inpage.editableOf)) ?? node;
    const taint = this.tainted();
    if (taint?.nodes.has(field) || taint?.nodes.has(node)) throw new Error(`${replace ? "filling" : "typing into"} ${label} is refused: ${TAINTED}`);
    await this.send("DOM.focus", { backendNodeId: field }).catch(() => this.click(field, label));
    await this.call(field, replace ? inpage.selectAll : inpage.caretToEnd);
    if (text) await this.send("Input.insertText", { text }, INPUT_MS);
    else if (replace) await this.key(parseKeys("Backspace"));
    if (!replace) return;
    const now = await this.call<string | null>(field, inpage.valueOf);
    if (now === null || now === text) return;
    const set = await this.call<string>(field, inpage.setValue, [{ value: text }]).catch((err: unknown) => {
      throw new Error(`${label} would not take the text: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Never what it holds: the text may be a password, and an error goes to the model and the transcript.
    if (set !== text) throw new Error(`${label} would not take the text as typed (it may format or limit what goes in); look to see what it holds now`);
  }

  private async choose(node: number, label: string, values: string[]): Promise<string[]> {
    const [before, since] = [this.life.loader, this.now()];
    const got = await this.call<{ picked?: string[]; error?: string; options?: string[] }>(node, inpage.selectOptions, [{ value: values }]);
    if (got.error === "not-select") throw new Error(`${label} is not a list box (<select>); click it, then click the option`);
    if (!got.picked?.length) throw new Error(`${label} has no option ${values.map((v) => JSON.stringify(v)).join(" or ")}; it has ${(got.options ?? []).join(", ")}`);
    await this.settle(before, since);
    return got.picked;
  }

  private async toggle(node: number, label: string, want: boolean): Promise<string> {
    const before = await this.call<boolean | null>(node, inpage.checkedOf);
    if (before === want) return `${label} was already ${want ? "checked" : "unchecked"}`;
    await this.acting(() => this.click(node, label));
    const after = await this.call<boolean | null>(node, inpage.checkedOf).catch(() => null);
    if (after !== null && after !== want) throw new Error(`clicking ${label} did not ${want ? "check" : "uncheck"} it`);
    return `${want ? "checked" : "unchecked"} ${label}`;
  }

  private async scroll(where: string): Promise<string> {
    if (where === "up" || where === "down") {
      const view = await this.viewport();
      await this.mouse("mouseWheel", { x: view.width / 2, y: view.height / 2 }, { deltaX: 0, deltaY: (where === "down" ? 1 : -1) * Math.round(view.height * 0.8) });
      await this.pause(250);
      return `scrolled ${where}`;
    }
    const node = await this.element(where);
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node });
    return `scrolled to ${where}`;
  }

  private async wait(what: Extract<Step, { wait: unknown }>["wait"]): Promise<string> {
    if (typeof what === "number") {
      await this.pause(what);
      return `waited ${what}ms`;
    }
    const [kind, value] = "text" in what ? (["text", what.text] as const) : "selector" in what ? (["selector", what.selector] as const) : (["gone", what.gone] as const);
    this.refsOnly(`waiting for ${kind === "selector" ? value : "words"}`);
    const check = `(${inpage.present.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(value)})`;
    const limit = what.ms ?? WAIT_FOR_MS;
    const end = this.now() + limit;
    while (this.now() < end) {
      // Each probe bounded by what is left, so a page slow to answer does not carry the wait past its grant.
      if (await this.value<boolean>(check, Math.max(1, Math.min(PROBE_MS, end - this.now()))).catch(() => false)) return kind === "gone" ? `"${value}" went` : `"${value}" appeared`;
      await this.pause(200);
    }
    throw new Error(`waited ${limit / 1000}s and ${JSON.stringify(value)} ${kind === "gone" ? "is still there" : "never appeared"}`);
  }

  // The parts.

  /** The element a target names: a ref from the last look, a text selector, or the first match of a CSS selector. */
  private async element(target: string): Promise<number> {
    const ref = /^@?(e\d+)$/.exec(target);
    if (ref) {
      const node = this.refs.nodeOf(ref[1]!);
      if (node === undefined) throw new Error(`there is no @${ref[1]} on this page; refs come from the last look, and a new page has new ones`);
      return node;
    }
    this.refsOnly(`aiming at ${target}`);
    const byText = textSelector(target);
    const expression = byText ? `(${inpage.byText.toString()})(${JSON.stringify(byText.base)}, ${JSON.stringify(byText.text)})` : `document.querySelector(${JSON.stringify(target)})`;
    const found = await this.send("Runtime.evaluate", { expression, objectGroup: GROUP }, EVAL_MS);
    if (found["exceptionDetails"]) throw new Error(`${target} is not a selector I can use: ${exceptionText(found["exceptionDetails"])}`);
    const objectId = (found["result"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new Error(`nothing on the page matches ${target}`);
    return this.backendOf(objectId);
  }

  private async backendOf(objectId: string): Promise<number> {
    const described = await this.send("DOM.describeNode", { objectId });
    const node = (described["node"] as { backendNodeId?: number } | undefined)?.backendNodeId;
    if (node === undefined) throw new Error("the element has no node");
    return node;
  }

  /** An element's handle in the page, resolved once a call. */
  private async objectOf(node: number): Promise<string> {
    if (this.objects.loader !== this.life.loader) this.objects = { loader: this.life.loader, ids: new Map() };
    const known = this.objects.ids.get(node);
    if (known) return known;
    const resolved = await this.send("DOM.resolveNode", { backendNodeId: node, objectGroup: GROUP }).catch(() => undefined);
    const objectId = (resolved?.["object"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new Error("that element is gone from the page (it changed); take a fresh look");
    this.objects.ids.set(node, objectId);
    return objectId;
  }

  /** A page-side function run on an element, its answer by value. */
  private async call<T>(node: number, fn: (this: Element, ...args: never[]) => unknown, args: CallArg[] = []): Promise<T> {
    const objectId = await this.objectOf(node);
    const answer = await this.send(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: fn.toString(), arguments: args, returnByValue: true, awaitPromise: true },
      EVAL_MS,
    );
    if (answer["exceptionDetails"]) throw new Error(exceptionText(answer["exceptionDetails"]));
    return (answer["result"] as { value?: T } | undefined)?.value as T;
  }

  /** A page-side function run on an element that answers with another element, or with none. */
  private async nodeVia(node: number, fn: (this: Element) => Element | null): Promise<number | undefined> {
    const objectId = await this.objectOf(node);
    const answer = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn.toString(), objectGroup: GROUP }, EVAL_MS);
    const other = (answer["result"] as { objectId?: string } | undefined)?.objectId;
    return other ? this.backendOf(other) : undefined;
  }

  /** An expression in the page, its answer by value. */
  private async value<T>(expression: string, timeoutMs = EVAL_MS): Promise<T> {
    const answer = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (answer["exceptionDetails"]) throw new Error(exceptionText(answer["exceptionDetails"]));
    return (answer["result"] as { value?: T } | undefined)?.value as T;
  }

  /** The middle of an element, scrolled into view; for a control hidden behind its label, the label's. */
  private async point(node: number, label: string, viaLabel = false): Promise<{ x: number; y: number }> {
    const [, quads] = await this.many([
      { method: "DOM.scrollIntoViewIfNeeded", params: { backendNodeId: node } },
      { method: "DOM.getContentQuads", params: { backendNodeId: node } },
    ]);
    const got = quads instanceof Error || !quads ? {} : quads;
    const quad = ((got["quads"] as number[][] | undefined) ?? []).find((q) => Math.abs((q[4]! - q[0]!) * (q[5]! - q[1]!)) > 1);
    if (quad) return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
    if (!viaLabel) {
      const drawnBy = await this.nodeVia(node, inpage.labelOf).catch(() => undefined);
      if (drawnBy !== undefined && drawnBy !== node) return this.point(drawnBy, label, true);
    }
    throw new Error(`${label} is not visible on the page (hidden, or inside something closed); open what holds it first`);
  }

  /**
   * Where a press on the element lands on it. Its middle, as the hands find
   * it; when something sits over that (most often a bar the page keeps at an
   * edge, over whatever was just scrolled to that edge), the element brought
   * to the middle of the view; failing that, another part of it that is
   * clear. Only an element covered everywhere is refused, naming what is in
   * the way, since then the page is waiting on that first.
   */
  private async reachable(node: number, label: string): Promise<{ x: number; y: number }> {
    const at = await this.point(node, label);
    const first = await this.blocker(node, at);
    if (first === undefined) return at;
    await this.call(node, inpage.centre).catch(() => undefined);
    const centred = await this.point(node, label);
    if ((await this.blocker(node, centred)) === undefined) return centred;
    for (const spot of await this.spots(node)) if ((await this.blocker(node, spot)) === undefined) return spot;
    const what = await this.call<string>(first, inpage.describe).catch(() => "something");
    throw new Error(`${label} is covered by ${what} @${this.refs.refOf(first)}; close or answer that first`);
  }

  /**
   * What a press at a point would land on instead of the element, if
   * anything. Hit as a real press is: through anything the pointer passes
   * through, such as the border KOS draws on a tab of the owner's Chrome,
   * which covers the whole page.
   */
  private async blocker(node: number, at: { x: number; y: number }): Promise<number | undefined> {
    const hit = await this
      .send("DOM.getNodeForLocation", { x: Math.round(at.x), y: Math.round(at.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false })
      .catch(() => undefined);
    const top = hit?.["backendNodeId"] as number | undefined;
    if (top === undefined || top === node) return undefined;
    const reached = await this.call<boolean>(node, inpage.reaches, [{ objectId: await this.objectOf(top) }]).catch(() => true);
    return reached ? undefined : top;
  }

  /** Other places on an element to press, inside its edges: its quarters, then near its corners. */
  private async spots(node: number): Promise<{ x: number; y: number }[]> {
    const got = await this.send("DOM.getContentQuads", { backendNodeId: node }).catch(() => ({}) as Record<string, unknown>);
    const quad = ((got["quads"] as number[][] | undefined) ?? [])[0];
    if (!quad) return [];
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const at = (fx: number, fy: number): { x: number; y: number } => ({ x: left + (right - left) * fx, y: top + (bottom - top) * fy });
    return [at(0.25, 0.5), at(0.75, 0.5), at(0.5, 0.25), at(0.5, 0.75), at(0.1, 0.15), at(0.9, 0.15), at(0.1, 0.85), at(0.9, 0.85)];
  }

  private mouseCall(type: string, at: { x: number; y: number }, extra: Record<string, unknown> = {}): Call {
    return { method: "Input.dispatchMouseEvent", params: { type, x: at.x, y: at.y, button: "none", modifiers: 0, ...extra } };
  }

  private async mouse(type: string, at: { x: number; y: number }, extra: Record<string, unknown> = {}): Promise<void> {
    await this.all([this.mouseCall(type, at, extra)]);
  }

  /** A key, with what is held around it, as one run of events. */
  private async key(press: KeyPress): Promise<void> {
    const calls: Call[] = [];
    const event = (params: Record<string, unknown>): void => void calls.push({ method: "Input.dispatchKeyEvent", params });
    let bits = 0;
    for (const held of press.held) {
      bits |= held.bit;
      event({ type: "rawKeyDown", key: held.key, code: held.code, windowsVirtualKeyCode: held.keyCode, modifiers: bits });
    }
    const base = { key: press.key, code: press.code, windowsVirtualKeyCode: press.keyCode, nativeVirtualKeyCode: press.keyCode, modifiers: press.modifiers };
    event({
      ...base,
      type: press.text ? "keyDown" : "rawKeyDown",
      ...(press.text ? { text: press.text, unmodifiedText: press.text } : {}),
      ...(press.commands ? { commands: press.commands } : {}),
    });
    event({ ...base, type: "keyUp" });
    for (const held of [...press.held].reverse()) {
      bits &= ~held.bit;
      event({ type: "keyUp", key: held.key, code: held.code, windowsVirtualKeyCode: held.keyCode, modifiers: bits });
    }
    await this.all(calls);
  }

  /** Commands in order (or side by side), in one round trip where the session can. */
  private many(calls: Call[], parallel = false): Promise<(Record<string, unknown> | Error)[]> {
    if (this.session.batch) return this.guard(this.session.batch(calls, parallel, INPUT_MS));
    return sendEach((m, p, t) => this.send(m, p, t), calls, parallel, INPUT_MS);
  }

  /** A command to the tab, no longer waited for once the owner presses Stop, and not sent after. */
  private send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (this.stop?.aborted) return Promise.reject(new Stopped());
    return this.guard(this.session.send(method, params, timeoutMs));
  }

  /** Work in flight, given up once the owner presses Stop; what it brings back after is let go of, not left for the page to hold. */
  private guard<T>(work: Promise<T>, stop = this.stop): Promise<T> {
    if (!stop) return work;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onStop = (): void => {
        if (settled) return;
        settled = true;
        reject(new Stopped());
        void work.then((r) => this.letGo(r), () => undefined);
      };
      if (stop.aborted) onStop();
      stop.addEventListener("abort", onStop, { once: true });
      work
        .then(
          (r) => {
            settled = true;
            resolve(r);
          },
          (err: unknown) => {
            settled = true;
            reject(err);
          },
        )
        .finally(() => stop.removeEventListener("abort", onStop));
    });
  }

  /** The page objects in answers no one waited for, released one by one: the group they were made in may be another call's by now. */
  private letGo(answer: unknown): void {
    for (const one of Array.isArray(answer) ? answer : [answer]) {
      if (typeof one !== "object" || one === null) continue;
      const r = one as { result?: { objectId?: unknown }; object?: { objectId?: unknown } };
      for (const objectId of [r.result?.objectId, r.object?.objectId]) {
        if (typeof objectId === "string") void this.session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  }

  /** A pause in a step, cut short by Stop. */
  private pause(ms: number): Promise<void> {
    return this.guard(sleep(ms));
  }

  /** Commands in order, the first error thrown. */
  private async all(calls: Call[]): Promise<void> {
    const failed = (await this.many(calls)).find((r) => r instanceof Error);
    if (failed) throw failed;
  }

  private async viewport(): Promise<{ width: number; height: number }> {
    const metrics = await this.send("Page.getLayoutMetrics");
    const view = (metrics["cssVisualViewport"] ?? metrics["layoutViewport"] ?? {}) as { clientWidth?: number; clientHeight?: number };
    return { width: view.clientWidth ?? 1280, height: view.clientHeight ?? 800 };
  }

  /** A new document: its elements are new, and so are their refs. */
  private freshDocument(): void {
    if (this.life.loader && this.life.loader !== this.documentId) {
      this.refs.clear();
      this.documentId = this.life.loader;
    }
  }

  /**
   * What can be acted on in a frame, found by the page itself in one call
   * (see inpage.controls), and in the frames it could not reach, each in its
   * own world, side by side. Undefined when the frame has no world of KOS's
   * own to look from. `frames` is how many more frames may be read.
   */
  private async found(frame: string, scope: string | null, frames: { left: number }, again = true): Promise<{ controls: Control[]; total: number; unread: string[]; closed: number } | undefined> {
    const context = await this.world(frame);
    if (context === undefined) return undefined;
    let answer: Record<string, unknown>;
    try {
      answer = await this.send(
        "Runtime.evaluate",
        { expression: `(${inpage.controls.toString()})(${JSON.stringify(scope)}, ${INDEX_MAX})`, contextId: context, objectGroup: GROUP },
        EVAL_MS,
      );
    } catch (err) {
      // Its document went since the world was made: once more, in a new one.
      this.worlds.delete(frame);
      if (again) return this.found(frame, scope, frames, false);
      throw err;
    }
    if (answer["exceptionDetails"]) {
      if (scope) throw new Error(`${scope} is not a selector I can use: ${exceptionText(answer["exceptionDetails"])}`);
      throw new Error(`the page could not be read: ${exceptionText(answer["exceptionDetails"])}`);
    }
    const objectId = (answer["result"] as { objectId?: string } | undefined)?.objectId;
    const props = objectId ? await this.send("Runtime.getProperties", { objectId, ownProperties: true }) : {};
    const byName = new Map(((props["result"] as { name: string; value?: { value?: unknown; objectId?: string } }[] | undefined) ?? []).map((p) => [p.name, p.value]));
    const meta = JSON.parse(String(byName.get("kos")?.value ?? "{}")) as { items?: inpage.FoundControl[]; total?: number; missing?: boolean };
    if (meta.missing) throw new Error(`nothing on the page matches ${scope}`);
    const items = meta.items ?? [];
    // An element that may hold a closed shadow root is asked of the browser, which sees through it.
    const describe = (item: inpage.FoundControl, i: number): Call => ({
      method: "DOM.describeNode",
      params: { objectId: byName.get(String(i))?.objectId ?? "", ...(item.closed ? { depth: 1, pierce: true } : {}) },
    });
    const described = items.length ? await this.many(items.map(describe), true) : [];
    type Described = { backendNodeId?: number; frameId?: string; shadowRoots?: { shadowRootType?: string }[] };
    const nodes = described.map((d) => (d instanceof Error ? undefined : (d["node"] as Described | undefined)));
    let closed = items.filter((item, i) => item.closed && nodes[i]?.shadowRoots?.some((r) => r.shadowRootType === "closed")).length;
    // The frames it could not reach, read beside one another.
    const inner = await Promise.all(
      items.map(async (item, i) => {
        if (item.frame === undefined) return undefined;
        if (item.loading) return { missed: item.frame };
        const id = nodes[i]?.frameId;
        if (!id || frames.left <= 0) return { missed: item.frame };
        frames.left--;
        const got = await this.found(id, null, frames).catch(() => undefined);
        return got ?? { missed: item.frame };
      }),
    );
    const controls: Control[] = [];
    const unread: string[] = [];
    let total = meta.total ?? 0;
    for (const [i, item] of items.entries()) {
      const from = inner[i];
      if (from && "missed" in from) {
        if (!from.missed.startsWith("about:")) unread.push(hostOf(from.missed));
        continue;
      }
      if (from) {
        controls.push(...from.controls.map((c) => (c.dialog === undefined && item.dialog !== undefined ? { ...c, dialog: item.dialog } : c)));
        unread.push(...from.unread);
        total += from.total;
        closed += from.closed;
        continue;
      }
      const node = nodes[i]?.backendNodeId;
      if (node === undefined || item.closed) continue;
      const value = item.value !== undefined && this.heldField(node) ? HIDDEN_VALUE : item.value;
      controls.push({ node, role: item.role, name: item.name, states: item.states, ...(value !== undefined ? { value } : {}), ...(item.dialog !== undefined ? { dialog: item.dialog } : {}), ...(item.more ? { more: item.more } : {}) });
    }
    return { controls, total, unread, closed };
  }

  /** The accessibility tree of the page and of the frames in it that live in its process, as one. */
  private async nodes(scope?: string): Promise<{ nodes: AxNode[]; unread: string[] }> {
    this.freshDocument();
    const [whole, tree] = await Promise.all([this.send("Accessibility.getFullAXTree", {}, AX_MS), this.send("Page.getFrameTree")]);
    const nodes = (whole["nodes"] as AxNode[] | undefined) ?? [];
    const unread: string[] = [];
    const frames = childFrames(tree["frameTree"]).slice(0, FRAMES_MAX);
    const read = await Promise.all(
      frames.map(async (frame) => {
        try {
          const [owner, inner] = await Promise.all([
            this.send("DOM.getFrameOwner", { frameId: frame.id }),
            this.send("Accessibility.getFullAXTree", { frameId: frame.id }, AX_MS),
          ]);
          return { owner: owner["backendNodeId"], inner: (inner["nodes"] as AxNode[] | undefined) ?? [] };
        } catch {
          if (frame.url && !frame.url.startsWith("about:")) unread.push(hostOf(frame.url));
          return undefined;
        }
      }),
    );
    for (const [i, got] of read.entries()) {
      if (!got) continue;
      const host = nodes.find((n) => n.backendDOMNodeId === got.owner);
      const root = got.inner.find((n) => !n.parentId);
      if (!host || !root) continue;
      const tag = `f${i}:`;
      for (const n of got.inner) {
        n.nodeId = tag + n.nodeId;
        if (n.parentId) n.parentId = tag + n.parentId;
        if (n.childIds) n.childIds = n.childIds.map((c) => tag + c);
      }
      root.parentId = host.nodeId;
      host.childIds = [...(host.childIds ?? []), root.nodeId];
      nodes.push(...got.inner);
    }
    await this.hideSecrets(nodes);
    if (!scope) return { nodes, unread };
    const within = await this.scopeNodes(scope);
    return { nodes: nodes.filter((n) => n.backendDOMNodeId !== undefined && within.has(n.backendDOMNodeId)), unread };
  }

  /**
   * Each field holding a secret has its value said as hidden, by its markup:
   * the tree says what a field holds but not that it is a card number. A
   * field whose markup cannot be read is hidden too.
   */
  private async hideSecrets(nodes: AxNode[]): Promise<void> {
    const valued = nodes.filter((n) => n.backendDOMNodeId !== undefined && holdsValue(n));
    if (valued.length === 0) return;
    const described = await this.many(valued.map((n) => ({ method: "DOM.describeNode", params: { backendNodeId: n.backendDOMNodeId } })), true);
    for (const [i, d] of described.entries()) {
      const flat = d instanceof Error ? undefined : (d["node"] as { attributes?: string[] } | undefined)?.attributes;
      const attributes = Object.fromEntries((flat ?? []).flatMap((v, j, all) => (j % 2 === 0 ? [[v.toLowerCase(), all[j + 1] ?? ""]] : [])));
      if (!flat || secretField(attributes) || this.heldField(valued[i]!.backendDOMNodeId!)) valued[i]!.value = { value: HIDDEN_VALUE };
    }
  }

  /** Every node inside what a selector names, through shadow roots and frames. */
  private async scopeNodes(scope: string): Promise<Set<number>> {
    const found = await this.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(scope)})`, objectGroup: GROUP }, EVAL_MS);
    if (found["exceptionDetails"]) throw new Error(`${scope} is not a selector I can use: ${exceptionText(found["exceptionDetails"])}`);
    const objectId = (found["result"] as { objectId?: string } | undefined)?.objectId;
    if (!objectId) throw new Error(`nothing on the page matches ${scope}`);
    const described = await this.send("DOM.describeNode", { objectId, depth: -1, pierce: true });
    const out = new Set<number>();
    const visit = (n: unknown): void => {
      const node = n as { backendNodeId?: number; children?: unknown[]; shadowRoots?: unknown[]; contentDocument?: unknown } | undefined;
      if (!node) return;
      if (node.backendNodeId !== undefined) out.add(node.backendNodeId);
      for (const c of node.children ?? []) visit(c);
      for (const c of node.shadowRoots ?? []) visit(c);
      visit(node.contentDocument);
    };
    visit(described["node"]);
    return out;
  }

  private onDialog(type: string, message: string): void {
    const chosen = this.answer ?? { accept: type === "alert" || type === "beforeunload" };
    this.answer = null;
    // Answered whatever else is under way, Stop included: an open dialog holds every later command on the tab.
    void this.session
      .send("Page.handleJavaScriptDialog", { accept: chosen.accept, ...(chosen.text !== undefined ? { promptText: chosen.text } : {}) })
      .catch(() => undefined);
    const said = message ? ` said ${JSON.stringify(message.length > 200 ? `${message.slice(0, 199)}…` : message)}` : " opened";
    const how = type === "alert" ? "was closed" : chosen.accept ? "was accepted" : `was dismissed; {dialog: "accept"} before the step that opens it accepts it`;
    this.heard.push(`A ${type === "beforeunload" ? "leave-this-page" : type} dialog${said}, and ${how}.`);
  }

  /** Until `ok`, or `ms` has gone (false); a Stop ends it at once. */
  private waitUntil(ok: () => boolean, ms: number): Promise<boolean> {
    if (ok()) return Promise.resolve(true);
    return this.guard(
      new Promise((resolve) => {
        const done = (v: boolean): void => {
          clearTimeout(timer);
          this.wakers.delete(check);
          resolve(v);
        };
        const check = (): void => {
          if (ok()) done(true);
        };
        const timer = setTimeout(() => done(false), ms);
        this.wakers.add(check);
      }),
    );
  }
}

/** Lists of values as one, each text once. */
function merged(...lists: (readonly FilledValue[])[]): FilledValue[] {
  const out: FilledValue[] = [];
  for (const list of lists) for (const v of list) if (!out.some((had) => had.text === v.text)) out.push(v);
  return out;
}

/** An address as a document is known by in history: less its fragment. */
function urlKey(url: string): string {
  return url.split("#")[0] ?? "";
}

/**
 * A selector by the words on the thing, as Playwright spells one and a model
 * writes one: `button:has-text('Submit')`, or `text=Submit` for anything.
 */
export function textSelector(target: string): { base: string; text: string } | undefined {
  const plain = /^text=(["']?)(.+)\1$/.exec(target.trim());
  if (plain) return { base: "", text: plain[2]! };
  const has = /^(.*):has-text\((["'])(.+)\2\)$/.exec(target.trim());
  return has ? { base: has[1]!.trim(), text: has[3]! } : undefined;
}
