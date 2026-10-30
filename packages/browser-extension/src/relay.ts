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
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Inspector.enable",
  "Network.enable",
  "Page.captureScreenshot",
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
  "Runtime.releaseObjectGroup",
]);

/** Events KOS's hands listen for; the rest stay in the browser. */
const EVENTS: ReadonlySet<string> = new Set([
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

/** A command checked before it reaches the tab: on the list, and if it navigates, to the web. */
export function checkCommand(method: string, params: Record<string, unknown>): void {
  if (!COMMANDS.has(method)) throw new CallError("method", `${method} is not one the extension passes on`);
  if (method === "Page.navigate") {
    const url = params["url"];
    if (typeof url !== "string" || !isWebUrl(url)) throw new CallError("url", "only web pages (http and https) open in your Chrome");
  }
}

/** Whether an event from a tab goes on to KOS. */
export function forwards(method: string): boolean {
  return EVENTS.has(method);
}

/** Pointer and key commands, which are KOS's own hands: told apart from the owner's. */
export function isInput(method: string): boolean {
  return method === "Input.dispatchMouseEvent" || method === "Input.dispatchKeyEvent" || method === "Input.insertText";
}
