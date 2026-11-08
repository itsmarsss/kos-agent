import { CallError } from "./protocol.js";

/**
 * What KOS may ask of a tab, and hear from it.
 *
 * KOS's hands drive a page with a few dozen DevTools commands: read the
 * page, aim the pointer and keys, go places. Those are the only ones the
 * extension passes on. A command that reaches past the tab (the browser,
 * its other tabs, every site's cookies, downloads, the file system) is not
 * on the list, and a navigation goes only to the web.
 */
export const COMMANDS: ReadonlySet<string> = new Set([
  "Accessibility.getFullAXTree",
  "DOM.describeNode",
  "DOM.focus",
  "DOM.getContentQuads",
  "DOM.getFrameOwner",
  "DOM.getNodeForLocation",
  "DOM.resolveNode",
  "DOM.scrollIntoViewIfNeeded",
  "Input.dispatchDragEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Input.setInterceptDrags",
  "Inspector.enable",
  "Network.enable",
  "Page.captureScreenshot",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.handleJavaScriptDialog",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.setLifecycleEventsEnabled",
  "Runtime.callFunctionOn",
  "Runtime.evaluate",
  "Runtime.getProperties",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
]);

/** Events KOS's hands listen for; the rest stay in the browser. */
const EVENTS: ReadonlySet<string> = new Set([
  "Input.dragIntercepted",
  "Inspector.targetCrashed",
  "Network.loadingFailed",
  "Network.loadingFinished",
  "Network.requestWillBeSent",
  "Page.frameNavigated",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.javascriptDialogOpening",
  "Page.lifecycleEvent",
  "Page.navigatedWithinDocument",
]);

/** Addresses a tab may be sent to: the web, and a blank page. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === "about:blank";
}

/** The world KOS's hands make for their page-side scripts (WORLD in packages/browser/src/page.ts): the one world KOS may make. */
export const HANDS_WORLD = "kos-hands";

/** The world the overlay runs in, whose binding speaks for the owner (Take over, Hand back, Stop). */
export const OVERLAY_WORLD = "kos";

/**
 * A command checked before it reaches the tab: on the list, and if it
 * navigates, to the web. A world KOS makes is its hands' own, by that name
 * and with no more reach than the page's. Which worlds its script may run
 * in is the tab's Worlds' to say.
 */
export function checkCommand(method: string, params: Record<string, unknown>): void {
  if (!COMMANDS.has(method)) throw new CallError("method", `${method} is not one the extension passes on`);
  if (method === "Page.navigate") {
    const url = params["url"];
    if (typeof url !== "string" || !isWebUrl(url)) throw new CallError("url", "only web pages (http and https) open in your Chrome");
  }
  if (method === "Page.createIsolatedWorld") {
    if (params["worldName"] !== HANDS_WORLD) throw new CallError("method", `the only world KOS may make is ${HANDS_WORLD}`);
    if (params["grantUniveralAccess"] !== undefined && params["grantUniveralAccess"] !== false) throw new CallError("method", "a world KOS makes has no more reach than the page");
  }
}

/** What a world in a tab is: the page's own or KOS's hands', which KOS may reach; the overlay's, or another's (an extension's), which it may not. */
type WorldKind = "page" | "hands" | "overlay" | "other";

/** Worlds gone from a tab that are still told apart from ones not heard of yet, at most. */
const GONE_MAX = 1_000;

/** The world an object lives in, from its id (isolate.context.object, as V8 writes it); undefined for an id not of that form. */
function worldOfObject(objectId: string): number | undefined {
  const parts = /^-?\d+\.(\d+)\.\d+$/.exec(objectId);
  return parts ? Number(parts[1]) : undefined;
}

/**
 * A tab's worlds, as Chrome said it made them (Runtime.executionContextCreated):
 * KOS's script runs, and its objects are made or reached, only in the
 * page's own worlds and its hands', each one Chrome has said it made. Any
 * other is refused, the overlay's among them, and so is one not heard of.
 */
export class Worlds {
  private readonly ids = new Map<number, WorldKind>();
  private readonly unique = new Map<string, WorldKind>();
  private readonly gone = new Set<number>();

  /** A world Chrome made, as Runtime.executionContextCreated gives it. */
  made(context: { id?: unknown; uniqueId?: unknown; name?: unknown; auxData?: { isDefault?: unknown } }): void {
    if (typeof context.id !== "number") return;
    const kind: WorldKind =
      context.name === OVERLAY_WORLD ? "overlay" : context.name === HANDS_WORLD ? "hands" : context.auxData?.isDefault === true ? "page" : "other";
    this.ids.set(context.id, kind);
    this.gone.delete(context.id);
    if (typeof context.uniqueId === "string") this.unique.set(context.uniqueId, kind);
  }

  /** A world gone with its document. */
  destroyed(id: number, uniqueId?: string): void {
    if (this.ids.delete(id)) this.gone.add(id);
    if (this.gone.size > GONE_MAX) this.gone.delete(this.gone.values().next().value!);
    if (uniqueId !== undefined) this.unique.delete(uniqueId);
  }

  /** Every world gone at once, as on a navigation. */
  cleared(): void {
    for (const id of [...this.ids.keys()]) this.destroyed(id);
    this.unique.clear();
  }

  isOverlay(id: number): boolean {
    return this.ids.get(id) === "overlay";
  }

  /** Whether each world a command names has been heard of, made or gone: one just made may not have been yet. */
  heard(params: Record<string, unknown>): boolean {
    const { ids, unique } = named(params);
    return ids.every((id) => this.ids.has(id) || this.gone.has(id)) && unique.every((u) => this.unique.has(u));
  }

  /** Refused unless each world a command names, by any of the names it may use, is the page's or KOS's hands'. */
  check(params: Record<string, unknown>): void {
    const { ids, unique } = named(params);
    for (const id of ids) reachable(`world ${id}`, this.ids.get(id), this.gone.has(id));
    for (const u of unique) reachable(`world ${u}`, this.unique.get(u), false);
  }
}

/** Refused unless a world is the page's or KOS's hands'; one gone is said to be, as Chrome would. */
function reachable(name: string, kind: WorldKind | undefined, gone: boolean): void {
  if (kind === "page" || kind === "hands") return;
  if (kind === "overlay") throw new CallError("method", "the overlay's world is the extension's own");
  if (kind === "other") throw new CallError("method", `${name} is neither the page's nor KOS's own`);
  if (gone) throw new CallError("cdp", `${name} is gone with its document; make it again`);
  throw new CallError("method", `${name} is not one Chrome has said this tab holds; KOS reaches only the page's world and its own`);
}

/**
 * The worlds a command's parameters name, by each of the names a command
 * may use: each read alone, since a command reads the one it knows and
 * ignores the rest. A name given as anything but what the protocol takes,
 * or an object whose id names no world, is refused, so none slips past by
 * its type.
 */
function named(params: Record<string, unknown>): { ids: number[]; unique: string[] } {
  const ids: number[] = [];
  for (const key of ["contextId", "executionContextId"]) {
    const id = params[key];
    if (id === undefined) continue;
    if (typeof id !== "number") throw new CallError("method", `${key} is a number`);
    ids.push(id);
  }
  const object = params["objectId"];
  if (object !== undefined) {
    const world = typeof object === "string" ? worldOfObject(object) : undefined;
    if (world === undefined) throw new CallError("method", "that object id names no world KOS can tell");
    ids.push(world);
  }
  const unique = params["uniqueContextId"];
  if (unique !== undefined && typeof unique !== "string") throw new CallError("method", "uniqueContextId is a string");
  return { ids, unique: unique === undefined ? [] : [unique] };
}

/**
 * The requests a page's answer waits on, as KOS's hands judge it (AWAITED in
 * packages/browser/src/page.ts): only these cross to KOS, and only the part
 * of them it reads. The rest (pictures, beacons, sockets, streams) and every
 * header stay in the browser.
 */
const AWAITED = new Set(["Document", "Script", "XHR", "Fetch"]);
/** Requests passed on and not ended yet, kept for one tab at most. */
const OPEN_MAX = 1_000;

/**
 * What of an event from a tab goes on to KOS: nothing, or what its hands
 * read of it. `open` is the tab's requests passed on that have not ended, so
 * the end of one is passed on only when its start was.
 */
export function forwarded(method: string, params: Record<string, unknown>, open: Set<string>): Record<string, unknown> | undefined {
  if (!EVENTS.has(method)) return undefined;
  const id = String(params["requestId"] ?? "");
  if (method === "Network.requestWillBeSent") {
    if (!AWAITED.has(String(params["type"] ?? ""))) return undefined;
    open.delete(id);
    open.add(id);
    if (open.size > OPEN_MAX) open.delete(open.values().next().value!);
    return { requestId: id, type: params["type"], timestamp: params["timestamp"], wallTime: params["wallTime"], request: { url: (params["request"] as { url?: unknown } | undefined)?.url } };
  }
  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") return open.delete(id) ? { requestId: id } : undefined;
  return params;
}

/** Pointer and key commands, which are KOS's own hands: told apart from the owner's. */
export function isInput(method: string): boolean {
  return method === "Input.dispatchMouseEvent" || method === "Input.dispatchKeyEvent" || method === "Input.insertText" || method === "Input.dispatchDragEvent";
}
