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
 * and with no more reach than the page's; script runs anywhere but in the
 * overlay's world, whose binding speaks for the owner (Take over, Hand back,
 * Stop).
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
  if (overlay && (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn")) {
    const id = params["contextId"] ?? params["executionContextId"];
    const unique = params["uniqueContextId"];
    if ((typeof id === "number" && overlay.ids.has(id)) || (typeof unique === "string" && overlay.unique.has(unique))) {
      throw new CallError("method", "the overlay's world is the extension's own");
    }
  }
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
    return { requestId: id, type: params["type"], request: { url: (params["request"] as { url?: unknown } | undefined)?.url } };
  }
  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") return open.delete(id) ? { requestId: id } : undefined;
  return params;
}

/** Pointer and key commands, which are KOS's own hands: told apart from the owner's. */
export function isInput(method: string): boolean {
  return method === "Input.dispatchMouseEvent" || method === "Input.dispatchKeyEvent" || method === "Input.insertText" || method === "Input.dispatchDragEvent";
}
