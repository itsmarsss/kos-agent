import { randomUUID } from "node:crypto";

import type { CdpClient, CdpEvent } from "@kos/browser";

import { parseRelay } from "./artifactcheck.js";

/**
 * A tab of the check's Chrome sealed for an export's render, so nothing the
 * artifact runs can reach out while KOS draws or prints it.
 *
 *  - Every request the tab or any frame in it makes is paused (Fetch, on the
 *    tab and on every frame Chrome attaches beside it) and failed, but the one
 *    document KOS answers itself, once, with no socket. A navigation, an
 *    image, a reload: refused before a byte is sent.
 *  - It can be offline from the start (DevTools' network emulation), which
 *    is what stops a WebSocket and what a preconnect would open: neither is
 *    a request Fetch sees. The exporter also takes every link, meta and base
 *    out of the artifact before it is drawn (withoutExits).
 *  - A window it opens is closed as it appears.
 *  - The kosRelay binding (a read relayed by the host document, or its word
 *    that the artifact's frame tried to leave) is heard only from the document KOS served, in the
 *    first context Chrome made for it in the tab's own frame: not from the
 *    artifact's frame (which the binding is also on), nor from anything the
 *    tab became after.
 *
 * The artifact is drawn inside the same wrapper and sandboxed frame as on
 * the dashboard (hostDocument), which stop the leaving on their own; this is
 * the second lock.
 */

/** Where a sealed tab's one document claims to come from: a name no resolver answers, which KOS answers itself. */
const DOCUMENT_ORIGIN = "http://export.kos.invalid";

export interface SealedOptions {
  /** Whether the tab runs scripts: a snapshot to print runs none, in its frame or any other. */
  scripts: boolean;
  /** Whether the tab is offline from the start (DevTools' own network emulation), which no socket, WebSocket or prefetch passes. */
  offline?: boolean;
  /** For a test: how many times slower every frame's CPU runs, as on a slow machine. */
  cpuThrottle?: number;
  /** Told each target the tab is, so whoever holds the job can close it. */
  track: (targetId: string) => void;
}

/** A read the served document relayed: what to answer, through which session. */
export interface RelayedCall {
  id: number;
  method: string;
  args: Record<string, unknown>;
}

interface Context {
  sessionId: string;
  id: number;
  frameId?: string;
  isDefault: boolean;
  origin: string;
}

export class SealedTab {
  readonly sessions = new Set<string>();
  readonly contexts: Context[] = [];
  /** What was refused, by URL: none, for an artifact that behaves. */
  readonly refused: string[] = [];
  private allowed: string | undefined;
  /** The document the one allowed request is answered with. */
  private document: string | undefined;
  private mainFrame: string | undefined;
  private relayContext: number | undefined;
  private off: () => void = () => undefined;
  private onLoad: (() => void) | undefined;

  private constructor(
    private readonly cdp: CdpClient,
    readonly targetId: string,
    readonly sessionId: string,
    private readonly relay: ((call: RelayedCall | "left") => void) | undefined,
    private readonly options: SealedOptions,
  ) {
    this.sessions.add(sessionId);
  }

  static async open(cdp: CdpClient, options: SealedOptions, relay?: (call: RelayedCall | "left") => void): Promise<SealedTab> {
    await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    options.track(targetId);
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const tab = new SealedTab(cdp, targetId, sessionId, relay, options);
    tab.off = cdp.on((e) => tab.heard(e));
    await tab.lock(sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    if (relay) await cdp.send("Runtime.addBinding", { name: "kosRelay" }, sessionId);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    const tree = (await cdp.send("Page.getFrameTree", {}, sessionId)) as { frameTree: { frame: { id: string } } };
    tab.mainFrame = tree.frameTree.frame.id;
    return tab;
  }

  /** The locks every session of the tab gets, its own and each frame's Chrome attaches beside it. */
  private async lock(session: string): Promise<void> {
    const { cdp, options } = this;
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);
    if (options.offline) {
      await cdp.send("Network.enable", {}, session);
      await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, session);
    }
    if (!options.scripts) await cdp.send("Emulation.setScriptExecutionDisabled", { value: true }, session);
    if (options.cpuThrottle) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle }, session);
    await cdp.send("Runtime.enable", {}, session);
  }

  /** Put this document in the tab's own frame, with no request at all. */
  async setContent(html: string): Promise<void> {
    await this.cdp.send("Page.setDocumentContent", { frameId: this.mainFrame, html }, this.sessionId);
  }

  /**
   * Load the one document the tab may have, answered by KOS itself through
   * the request's interception: no socket is opened for it, so the tab can be
   * offline from the start.
   */
  async navigate(html: string): Promise<void> {
    const url = `${DOCUMENT_ORIGIN}/${randomUUID()}`;
    this.allowed = url;
    this.document = html;
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
  }

  /** Resolves once the served document has loaded, or after ms, whichever is first. */
  loaded(ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(done, ms);
      this.onLoad = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  /** Answer a relayed call in the served document. */
  reply(answer: Record<string, unknown>): Promise<unknown> {
    if (this.relayContext === undefined) return Promise.resolve();
    return this.cdp.send("Runtime.evaluate", { expression: `window.__kosReply(${JSON.stringify(answer)})`, contextId: this.relayContext }, this.sessionId).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.off();
    // A throttled renderer can outlive its tab and draw the next one: it is given back its full speed first.
    if (this.options.cpuThrottle) await Promise.all([...this.sessions].map((s) => this.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }, s).catch(() => undefined)));
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }

  private heard(e: CdpEvent): void {
    const p = (e.params ?? {}) as Record<string, unknown>;
    // A window the tab opened: closed, whatever it holds.
    if (e.method === "Target.targetCreated") {
      const info = p.targetInfo as { targetId: string; openerId?: string };
      if (info.openerId === this.targetId) void this.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
      return;
    }
    if (!e.sessionId || !this.sessions.has(e.sessionId)) return;
    const session = e.sessionId;
    if (e.method === "Target.attachedToTarget") {
      const child = p.sessionId as string;
      this.sessions.add(child);
      // Held until it has the tab's locks: a frame in a process of its own gets no script, no network, no request the tab would refuse.
      void this.lock(child)
        .catch(() => undefined)
        .then(() => this.cdp.send("Runtime.runIfWaitingForDebugger", {}, child))
        .catch(() => undefined);
    } else if (e.method === "Fetch.requestPaused") {
      const url = (p.request as { url: string }).url;
      const requestId = p.requestId as string;
      if (url === this.allowed && session === this.sessionId && this.document !== undefined) {
        const body = Buffer.from(this.document, "utf8").toString("base64");
        this.allowed = undefined;
        this.document = undefined;
        void this.cdp
          .send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }, { name: "cache-control", value: "no-store" }], body }, session)
          .catch(() => undefined);
      } else {
        this.refused.push(url);
        void this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, session).catch(() => undefined);
      }
    } else if (e.method === "Page.loadEventFired" && session === this.sessionId) {
      this.onLoad?.();
    } else if (e.method === "Runtime.executionContextCreated") {
      const c = p.context as { id: number; origin: string; auxData?: { frameId?: string; isDefault?: boolean } };
      const context: Context = { sessionId: session, id: c.id, isDefault: c.auxData?.isDefault === true, origin: c.origin, ...(c.auxData?.frameId ? { frameId: c.auxData.frameId } : {}) };
      this.contexts.push(context);
      // The served document's own: the first in the tab's frame with a web origin. Whatever the tab became after is no one KOS answers.
      if (this.relayContext === undefined && session === this.sessionId && context.isDefault && context.frameId === this.mainFrame && /^https?:/.test(context.origin)) this.relayContext = c.id;
    } else if (e.method === "Runtime.bindingCalled" && this.relay && p.name === "kosRelay") {
      if (session !== this.sessionId || p.executionContextId !== this.relayContext) return;
      const m = parseRelay(p.payload);
      // The wrapper saw the artifact's frame load a second time: it tried to leave.
      if (m?.left === true) return this.relay("left");
      if (m?.id === undefined || typeof m.method !== "string") return;
      this.relay({ id: m.id, method: m.method, args: m.args ?? {} });
    }
  }
}

/**
 * The artifact's frame as it was drawn, as a document to print with no
 * script: its markup with the scripts, links, frames and refreshes taken
 * out, every stylesheet it ended with (a runtime's, a library's rules put in
 * through the CSSOM) written as one, a canvas as the picture it drew, and
 * the frame's own scroll set aside. Run in the frame, after the artifact's
 * own code, which can replace every method this calls: what comes back is
 * the artifact's word, not KOS's, and is only ever printed once printsafe.ts
 * has rebuilt it.
 */
export const SNAPSHOT = String.raw`(function(){
var root=document.documentElement,clone=root.cloneNode(true);
var live=root.querySelectorAll("canvas"),copies=clone.querySelectorAll("canvas");
for(var i=0;i<live.length&&i<copies.length;i++){try{var r=live[i].getBoundingClientRect(),img=document.createElement("img");img.src=live[i].toDataURL();img.className=live[i].className;img.style.cssText=live[i].style.cssText;img.style.width=r.width+"px";img.style.height=r.height+"px";copies[i].replaceWith(img)}catch(e){}}
clone.querySelectorAll("script,link,iframe,frame,object,embed,base,portal,style,noscript,template").forEach(function(n){n.remove()});
clone.querySelectorAll("meta[http-equiv]").forEach(function(n){if(!/^content-security-policy$/i.test(n.getAttribute("http-equiv")||""))n.remove()});
var css=[],sheets=[].slice.call(document.styleSheets).concat([].slice.call(document.adoptedStyleSheets||[]));
sheets.forEach(function(s){try{var t=[].map.call(s.cssRules,function(x){return x.cssText}).join("\n");var m=s.media&&s.media.mediaText;css.push(m?"@media "+m+"{"+t+"}":t)}catch(e){}});
var style=document.createElement("style");style.textContent=css.join("\n");
var head=clone.querySelector("head");if(head)head.appendChild(style);
clone.style.removeProperty("overflow-x");clone.style.removeProperty("overflow-y");
return "<!doctype html>"+clone.outerHTML})()`;
