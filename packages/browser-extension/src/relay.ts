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

/** The overlay's worlds in a tab, by id and by unique id: the extension's own, never KOS's to run script in. */
export interface OverlayWorlds {
  ids: ReadonlySet<number>;
  unique: ReadonlySet<string>;
}

/**
 * A command checked before it reaches the tab: on the list, and if it
 * navigates, to the web. A world KOS makes is its hands' own, by that name
 * and with no more reach than the page's; script runs, and objects are
 * made or reached, anywhere but in the overlay's world, whose binding speaks
 * for the owner (Take over, Hand back, Stop).
 */
export function checkCommand(method: string, params: Record<string, unknown>, overlay?: OverlayWorlds): void {
  if (!COMMANDS.has(method)) throw new CallError("method", `${method} is not one the extension passes on`);
  if (method === "Page.navigate") {
    const url = params["url"];
    if (typeof url !== "string" || !isWebUrl(url)) throw new CallError("url", "only web pages (http and https) open in your Chrome");
  }
  if (method === "Page.createIsolatedWorld") {
    if (params["worldName"] !== HANDS_WORLD) throw new CallError("method", `the only world KOS may make is ${HANDS_WORLD}`);
    if (params["grantUniveralAccess"] !== undefined && params["grantUniveralAccess"] !== false) throw new CallError("method", "a world KOS makes has no more reach than the page");
  }
  if (reachesOverlay(params, overlay ?? NO_OVERLAY)) throw new CallError("method", "the overlay's world is the extension's own");
}

const NO_OVERLAY: OverlayWorlds = { ids: new Set(), unique: new Set() };

/** The world an object lives in, from its id (isolate.context.object, as V8 writes it); undefined for an id not of that form. */
function worldOfObject(objectId: string): number | undefined {
  const parts = /^-?\d+\.(\d+)\.\d+$/.exec(objectId);
  return parts ? Number(parts[1]) : undefined;
}

/**
 * Whether a command's parameters name the overlay's world, or an object in
 * it, by any of the names a command may use: each checked alone, since a
 * command reads the one it knows and ignores the rest. A name given as
 * anything but what the protocol takes is refused as well, so none slips
 * past by its type.
 */
function reachesOverlay(params: Record<string, unknown>, overlay: OverlayWorlds): boolean {
  for (const key of ["contextId", "executionContextId"]) {
    const id = params[key];
    if (id !== undefined && (typeof id !== "number" || overlay.ids.has(id))) return true;
  }
  const unique = params["uniqueContextId"];
  if (unique !== undefined && (typeof unique !== "string" || overlay.unique.has(unique))) return true;
  const object = params["objectId"];
  if (object === undefined) return false;
  if (typeof object !== "string") return true;
  const world = worldOfObject(object);
  return world !== undefined && overlay.ids.has(world);
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
